import type {
	IBinaryData,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	IWebhookFunctions,
	JsonObject,
	ResourceMapperField,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

type Context = IExecuteFunctions | ILoadOptionsFunctions | IWebhookFunctions;

export const CREDENTIALS_NAME = 'artificialStudioApi';
const DEFAULT_BASE_URL = 'https://api.artificialstudio.ai';

// ---------------------------------------------------------------- API shapes

export interface SchemaProperty {
	type?: string;
	enum?: string[];
	items?: { type?: string };
	default?: unknown;
	optional?: boolean;
	label?: string;
	description?: string;
	inputType?: string;
	fileType?: string;
	// Models label their choices for the app's UI ("MOV (ProRes)" for
	// "mov_proresks"); reuse those labels instead of the raw enum values.
	options?: Array<{ label?: string; value?: string | number }>;
}

export interface InputSchema {
	type?: string;
	properties?: Record<string, SchemaProperty>;
	required?: string[];
}

export interface ToolSummary {
	slug: string;
	name: string;
	description?: string;
	type?: string;
	outputType?: string;
}

export interface ToolModel {
	slug: string;
	name: string;
	cost?: number;
	costUnit?: string;
	inputSchema?: InputSchema;
}

export interface ToolDetail extends ToolSummary {
	inputSchema?: InputSchema | null;
	models?: ToolModel[];
}

export interface Generation {
	id: string;
	status: string;
	tool?: string;
	type?: string;
	output?: string | null;
	thumbnail?: string | null;
	error?: string | null;
	payload?: IDataObject;
	createdAt?: string;
}

export interface GenerationList {
	data: Generation[];
	pagination?: { total?: number; limit?: number; offset?: number; hasMore?: boolean };
}

export interface UploadedFile {
	id: string;
	url: string;
	mimetype?: string;
	size?: number;
	originalName?: string;
}

// ----------------------------------------------------------------- requests

async function baseUrl(ctx: Context): Promise<string> {
	const credentials = await ctx.getCredentials(CREDENTIALS_NAME);
	return String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function statusOf(error: unknown): number {
	const e = error as
		| {
				httpCode?: string | number;
				statusCode?: number;
				response?: { status?: number };
				cause?: { statusCode?: number; response?: { status?: number } };
		  }
		| undefined;
	return (
		Number(
			e?.httpCode ??
				e?.statusCode ??
				e?.response?.status ??
				e?.cause?.statusCode ??
				e?.cause?.response?.status ??
				0,
		) || 0
	);
}

const FRIENDLY_MESSAGES: Record<number, string> = {
	401: 'Invalid API key. Create one at artificialstudio.ai → Settings → API Keys and update the credential',
	402: 'Not enough credits on your Artificial Studio account. Top up at artificialstudio.ai/pricing',
	403: 'This resource belongs to another Artificial Studio account',
	404: 'Not found. Check the tool slug, model slug or generation ID',
	429: 'Artificial Studio rate limit reached. Enable "Retry On Fail" in the node settings to wait and retry',
};

/**
 * Wraps any failure from the API into an n8n error with a readable message.
 */
export function toNodeError(ctx: Context, error: unknown, itemIndex?: number): Error {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;

	const e = (error ?? {}) as {
		message?: string;
		description?: string;
		response?: { data?: unknown };
		cause?: { response?: { data?: unknown } };
	};
	const status = statusOf(error);
	const data = (e.response?.data ?? e.cause?.response?.data) as
		| { message?: string; errors?: Array<{ field?: string; message?: string }> }
		| string
		| undefined;

	const apiMessage =
		(typeof data === 'object' ? data?.message : data) ??
		e.description ??
		e.message ??
		'Request to Artificial Studio failed';
	const details =
		typeof data === 'object' && data?.errors?.length
			? data.errors.map((x) => [x.field, x.message].filter(Boolean).join(': ')).join('; ')
			: '';

	const message = FRIENDLY_MESSAGES[status] ?? apiMessage;
	const description = [message !== apiMessage ? apiMessage : '', details]
		.filter(Boolean)
		.join(' — ');

	return new NodeApiError(ctx.getNode(), (error ?? {}) as unknown as JsonObject, {
		message,
		description: description || undefined,
		httpCode: status ? String(status) : undefined,
		itemIndex,
	});
}

/**
 * Normalises anything thrown during an item's execution into an n8n error and
 * tags it with the item index. Returns instead of throwing so callers keep a
 * single `throw` site.
 */
export function toItemError(ctx: Context, error: unknown, itemIndex: number): Error {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) {
		if (error.context) error.context.itemIndex = itemIndex;
		return error;
	}
	return new NodeOperationError(ctx.getNode(), error as Error, { itemIndex });
}

export interface ApiRequestOptions {
	body?: IDataObject | Buffer;
	qs?: IDataObject;
	headers?: IDataObject;
	json?: boolean;
}

export async function apiRequest<T = IDataObject>(
	ctx: Context,
	method: IHttpRequestMethods,
	endpoint: string,
	{ body, qs, headers, json = true }: ApiRequestOptions = {},
): Promise<T> {
	const options: IHttpRequestOptions = {
		method,
		url: `${await baseUrl(ctx)}/api${endpoint}`,
		qs,
		headers,
		json,
	};
	if (body !== undefined) options.body = body;

	try {
		return (await ctx.helpers.httpRequestWithAuthentication.call(
			ctx,
			CREDENTIALS_NAME,
			options,
		)) as T;
	} catch (error) {
		throw toNodeError(ctx, error);
	}
}

/**
 * Retries network failures, 429s and 5xx responses with exponential backoff.
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	{ attempts = 4, baseDelayMs = 1500 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			const status = statusOf(error);
			const transient = status === 0 || status === 429 || status >= 500;
			if (!transient) break;
			if (attempt < attempts - 1) await sleep(baseDelayMs * 2 ** attempt);
		}
	}
	throw lastError;
}

const toolCache = new WeakMap<object, Map<string, Promise<ToolDetail>>>();

/**
 * Tool details (models + input schemas) memoised per execution context.
 */
export async function getToolDetail(ctx: Context, slug: string): Promise<ToolDetail> {
	let cache = toolCache.get(ctx);
	if (!cache) {
		cache = new Map();
		toolCache.set(ctx, cache);
	}
	let pending = cache.get(slug);
	if (!pending) {
		pending = apiRequest<ToolDetail>(ctx, 'GET', `/tools/${encodeURIComponent(slug)}`);
		cache.set(slug, pending);
	}
	return await pending;
}

// ---------------------------------------------------------------- generations

export async function waitForGeneration(
	ctx: IExecuteFunctions,
	id: string,
	timeoutMs: number,
): Promise<Generation> {
	const startedAt = Date.now();
	let delay = 2000;
	let last: Generation | undefined;

	while (Date.now() - startedAt < timeoutMs) {
		await sleep(delay);
		last = await withRetry(() =>
			apiRequest<Generation>(ctx, 'GET', `/generations/${encodeURIComponent(id)}`),
		);
		if (last.status === 'success') return last;
		if (last.status === 'error') {
			throw new NodeOperationError(
				ctx.getNode(),
				`Generation ${id} failed: ${last.error ?? 'unknown error'}`,
			);
		}
		delay = Math.min(Math.round(delay * 1.5), 10000);
	}

	throw new NodeOperationError(
		ctx.getNode(),
		`Generation ${id} did not finish within ${Math.round(timeoutMs / 1000)}s (last status: ${last?.status ?? 'unknown'})`,
		{
			description:
				'Increase "Timeout", switch "Wait For Result" to "Wait For Webhook", or use "Return Immediately" and fetch the result later with Generation → Get',
		},
	);
}

export async function downloadOutput(
	ctx: IExecuteFunctions | IWebhookFunctions,
	generation: Generation,
): Promise<IBinaryData | undefined> {
	if (!generation.output) return undefined;

	const response = (await ctx.helpers.httpRequest({
		method: 'GET',
		url: generation.output,
		encoding: 'arraybuffer',
		returnFullResponse: true,
		json: false,
	})) as { body: ArrayBuffer | Buffer; headers: IDataObject };

	const buffer = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body);
	const contentType = String(response.headers['content-type'] ?? '').split(';')[0] || undefined;
	const fileName =
		decodeURIComponent(new URL(generation.output).pathname.split('/').pop() ?? '') ||
		generation.id;

	return await ctx.helpers.prepareBinaryData(buffer, fileName, contentType);
}

// ---------------------------------------------------------------- uploads

/**
 * Uploads a binary item property and returns the public URL to put in an input.
 */
export async function uploadBinary(
	ctx: IExecuteFunctions,
	itemIndex: number,
	propertyName: string,
	keepInLibrary: boolean,
): Promise<UploadedFile> {
	const binary = ctx.helpers.assertBinaryData(itemIndex, propertyName);
	const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, propertyName);

	const fileName = (binary.fileName || `upload.${binary.fileExtension || 'bin'}`)
		// Header values must be plain ASCII.
		.replace(/[^\x20-\x7e]/g, '_');

	const response = await apiRequest<UploadedFile | string>(
		ctx,
		'POST',
		`/files?transient=${keepInLibrary ? 'false' : 'true'}`,
		{
			body: buffer,
			headers: {
				'Content-Type': binary.mimeType || 'application/octet-stream',
				'X-Filename': fileName,
			},
			json: false,
		},
	);

	return typeof response === 'string' ? (JSON.parse(response) as UploadedFile) : response;
}

// ----------------------------------------------------------- schema helpers

const RESERVED_FIELDS = new Set(['prompt', 'model']);

export function isMediaField(key: string, prop: SchemaProperty): boolean {
	return prop.inputType === 'gallery' || !!prop.fileType || /_urls?$/.test(key);
}

export function resolveSchema(
	tool: ToolDetail,
	modelSlug?: string,
): { properties: Record<string, SchemaProperty>; required: string[] } {
	const models = tool.models ?? [];
	const model = modelSlug ? models.find((m) => m.slug === modelSlug) : models[0];
	const modelSchema = model?.inputSchema;
	const schema =
		modelSchema && Object.keys(modelSchema.properties ?? {}).length
			? modelSchema
			: (tool.inputSchema ?? {});
	return { properties: schema.properties ?? {}, required: schema.required ?? [] };
}

const ACRONYMS: Record<string, string> = { url: 'URL', urls: 'URLs', id: 'ID', ids: 'IDs' };

function titleCase(key: string): string {
	return key
		.replace(/[_-]+/g, ' ')
		.trim()
		.split(' ')
		.map((word) => ACRONYMS[word.toLowerCase()] ?? word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

export function mediaFieldOptions(tool: ToolDetail, modelSlug?: string): INodePropertyOptions[] {
	const { properties } = resolveSchema(tool, modelSlug);
	return Object.entries(properties)
		.filter(([key, prop]) => isMediaField(key, prop))
		.map(([key, prop]) => ({
			name: `${prop.label ?? titleCase(key)}${prop.type === 'array' ? ' (multiple)' : ''}`,
			value: key,
			description: prop.description,
		}));
}

export function parameterFields(tool: ToolDetail, modelSlug?: string): ResourceMapperField[] {
	const { properties, required } = resolveSchema(tool, modelSlug);
	const fields: ResourceMapperField[] = [];

	for (const [key, prop] of Object.entries(properties)) {
		if (RESERVED_FIELDS.has(key) || isMediaField(key, prop)) continue;

		const isRequired = required.includes(key) && prop.default === undefined && !prop.optional;
		const suffix = prop.default !== undefined ? ` (default: ${String(prop.default)})` : '';
		const field: ResourceMapperField = {
			id: key,
			displayName: `${prop.label ?? titleCase(key)}${suffix}`,
			required: isRequired,
			defaultMatch: false,
			display: true,
			canBeUsedToMatch: false,
			type: 'string',
		};

		const labelled = prop.options?.filter((o) => o.value !== undefined) ?? [];
		if (labelled.length) {
			field.type = 'options';
			field.options = labelled.map((o) => ({
				name: String(o.label ?? o.value),
				value: o.value as string | number,
			}));
		} else if (prop.type === 'enum' && prop.enum?.length) {
			field.type = 'options';
			field.options = prop.enum.map((value) => ({ name: String(value), value }));
		} else if (prop.type === 'number' || prop.type === 'int') {
			field.type = 'number';
		} else if (prop.type === 'boolean') {
			field.type = 'boolean';
		} else if (prop.type === 'array') {
			field.displayName += ' (comma-separated)';
		}

		fields.push(field);
	}

	return fields;
}

/**
 * Turns resource-mapper values into the typed input the API expects. Empty
 * values are dropped so the model defaults apply.
 */
export function coerceParameters(
	values: IDataObject,
	properties: Record<string, SchemaProperty>,
): IDataObject {
	const input: IDataObject = {};

	for (const [key, raw] of Object.entries(values ?? {})) {
		if (raw === undefined || raw === null || raw === '') continue;
		const prop = properties[key];

		if (prop?.type === 'number' || prop?.type === 'int') {
			const n = Number(raw);
			if (Number.isNaN(n)) throw new Error(`"${key}" must be a number, got "${String(raw)}"`);
			input[key] = n;
		} else if (prop?.type === 'boolean') {
			input[key] =
				typeof raw === 'string' ? ['true', '1', 'yes'].includes(raw.toLowerCase()) : !!raw;
		} else if (prop?.type === 'array') {
			input[key] = toArray(raw);
		} else {
			input[key] = raw as IDataObject[string];
		}
	}

	return input;
}

export function toArray(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (trimmed.startsWith('[')) return JSON.parse(trimmed) as unknown[];
		return trimmed
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return [raw];
}
