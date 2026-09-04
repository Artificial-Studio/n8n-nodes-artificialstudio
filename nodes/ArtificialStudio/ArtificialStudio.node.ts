import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	ResourceMapperFields,
	ResourceMapperValue,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, WAIT_INDEFINITELY } from 'n8n-workflow';

import {
	apiRequest,
	coerceParameters,
	downloadOutput,
	getToolDetail,
	mediaFieldOptions,
	parameterFields,
	resolveSchema,
	toArray,
	toItemError,
	uploadBinary,
	waitForGeneration,
	withRetry,
	type Generation,
	type GenerationList,
	type ToolDetail,
	type ToolSummary,
	type UploadedFile,
} from './GenericFunctions';

interface MediaInput {
	field: string;
	source: 'url' | 'binary';
	url?: string;
	binaryProperty?: string;
}

interface RunOptions {
	download?: boolean;
	binaryProperty?: string;
	keepUploads?: boolean;
	webhookUrl?: string;
}

// The `webhooks` entry below is a resume endpoint (`restartWebhook`), not a
// subscription registered on a third-party service: n8n mints the URL per
// execution and the node hands it to the API on the run request, so there is
// nothing to create, verify or delete. webhookMethods does not apply.
// eslint-disable-next-line @n8n/community-nodes/webhook-lifecycle-complete
export class ArtificialStudio implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Artificial Studio',
		name: 'artificialStudio',
		icon: { light: 'file:artificialstudio.svg', dark: 'file:artificialstudio.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Generate images, video, audio and 3D with 150+ AI models on Artificial Studio',
		defaults: {
			name: 'Artificial Studio',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'artificialStudioApi',
				required: true,
			},
		],
		// Resume endpoint for "Wait For Webhook".
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: '',
				restartWebhook: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'File', value: 'file' },
					{ name: 'Generation', value: 'generation' },
					{ name: 'Tool', value: 'tool' },
				],
				default: 'generation',
			},

			// ------------------------------------------------------- operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['generation'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get a generation',
						description: 'Fetch a generation by ID to check its status and output',
					},
					{
						name: 'Get Many',
						value: 'getMany',
						action: 'Get many generations',
						description: 'List your generations',
					},
					{
						name: 'Run Tool',
						value: 'run',
						action: 'Run a tool',
						description: 'Generate an image, video, audio or 3D object with any tool',
					},
				],
				default: 'run',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['tool'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get a tool',
						description: 'Get a tool with its models, costs and input fields',
					},
					{
						name: 'Get Many',
						value: 'getMany',
						action: 'Get many tools',
						description: 'List all available tools',
					},
				],
				default: 'getMany',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['file'] } },
				options: [
					{
						name: 'Upload',
						value: 'upload',
						action: 'Upload a file',
						description: 'Upload a binary file and get a public URL to use as a generation input',
					},
				],
				default: 'upload',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get account info',
						description: 'Get your email, plan and remaining credits',
					},
				],
				default: 'get',
			},

			// --------------------------------------------------- generation:run
			{
				displayName: 'Tool Name or ID',
				name: 'tool',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTools' },
				required: true,
				displayOptions: { show: { resource: ['generation'], operation: ['run'] } },
				default: '',
				hint: 'What to generate: an image, a video, a 3D object, speech, an upscale…',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Model Name or ID',
				name: 'model',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getModels', loadOptionsDependsOn: ['tool'] },
				displayOptions: { show: { resource: ['generation'], operation: ['run'] } },
				default: '',
				hint: "Each model is listed with its cost in credits. Leave on \"Tool Default\" for the tool's primary model.",
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 3 },
				displayOptions: { show: { resource: ['generation'], operation: ['run'] } },
				default: '',
				description:
					'What to generate. Leave empty for tools that take no prompt, such as background removal or upscaling.',
			},
			{
				displayName: 'Media Inputs',
				name: 'mediaInputs',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Media Input',
				default: {},
				displayOptions: { show: { resource: ['generation'], operation: ['run'] } },
				description:
					'Images, videos or audio the tool works on. Use a public URL or a binary file from a previous node.',
				options: [
					{
						name: 'inputs',
						displayName: 'Input',
						values: [
							{
								displayName: 'Field Name or ID',
								name: 'field',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getMediaFields',
									loadOptionsDependsOn: ['tool', 'model'],
								},
								default: '',
								hint: 'Which input of the model this file goes to',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
								displayName: 'Source',
								name: 'source',
								type: 'options',
								options: [
									{ name: 'Binary File', value: 'binary' },
									{ name: 'URL', value: 'url' },
								],
								default: 'url',
								description: 'Where the file comes from',
							},
							{
								displayName: 'URL',
								name: 'url',
								type: 'string',
								displayOptions: { show: { source: ['url'] } },
								default: '',
								placeholder: 'https://example.com/photo.jpg',
								description: 'Public URL of the file',
							},
							{
								displayName: 'Input Binary Field',
								name: 'binaryProperty',
								type: 'string',
								displayOptions: { show: { source: ['binary'] } },
								default: 'data',
								hint: 'The name of the input binary field containing the file to upload',
								description: 'The file is uploaded to Artificial Studio first, then used as the input',
							},
						],
					},
				],
			},
			{
				displayName: 'Parameters',
				name: 'parameters',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				displayOptions: { show: { resource: ['generation'], operation: ['run'] } },
				typeOptions: {
					loadOptionsDependsOn: ['tool', 'model'],
					resourceMapper: {
						resourceMapperMethod: 'getModelParameters',
						mode: 'add',
						fieldWords: { singular: 'parameter', plural: 'parameters' },
						addAllFields: true,
						multiKeyMatch: false,
						supportAutoMap: false,
					},
				},
				description:
					'Model settings such as aspect ratio, duration or resolution. Empty values use the model defaults.',
			},
			{
				displayName: 'Wait For Result',
				name: 'wait',
				type: 'options',
				displayOptions: { show: { resource: ['generation'], operation: ['run'] } },
				options: [
					{
						name: 'Poll Until Done',
						value: 'poll',
						description: 'Check the status every few seconds and return the finished generation',
					},
					{
						name: 'Return Immediately',
						value: 'none',
						description: 'Return the generation ID right away and fetch the result later',
					},
					{
						name: 'Wait For Webhook',
						value: 'webhook',
						description:
							'Pause the execution without polling and resume when Artificial Studio calls back. Needs an n8n URL reachable from the internet.',
					},
				],
				default: 'poll',
				description: 'How to get the finished generation',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeout',
				type: 'number',
				typeOptions: { minValue: 10 },
				displayOptions: {
					show: { resource: ['generation'], operation: ['run'], wait: ['poll'] },
				},
				default: 600,
				description: 'How long to poll before giving up. Videos and 3D can take several minutes.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['generation'], operation: ['run', 'get'] } },
				options: [
					{
						displayName: 'Download Output',
						name: 'download',
						type: 'boolean',
						default: false,
						description:
							'Whether to download the generated file into a binary field so the next node can use it directly',
					},
					{
						displayName: 'Keep Uploads in Library',
						name: 'keepUploads',
						type: 'boolean',
						default: true,
						displayOptions: { show: { '/operation': ['run'] } },
						description:
							'Whether files uploaded from binary inputs stay visible in your Artificial Studio library',
					},
					{
						displayName: 'Output Binary Field',
						name: 'binaryProperty',
						type: 'string',
						default: 'data',
						description: 'Name of the binary field to write the downloaded output to',
					},
					{
						displayName: 'Webhook URL',
						name: 'webhookUrl',
						type: 'string',
						default: '',
						placeholder: 'https://',
						displayOptions: { show: { '/operation': ['run'] } },
						description:
							'Your own HTTPS URL to notify when the generation finishes. Only used with "Return Immediately".',
					},
				],
			},

			// --------------------------------------------------- generation:get
			{
				displayName: 'Generation ID',
				name: 'generationId',
				type: 'string',
				required: true,
				displayOptions: { show: { resource: ['generation'], operation: ['get'] } },
				default: '',
				description: 'ID returned when the generation was created',
			},

			// ----------------------------------------------- generation:getMany
			{
				displayName: 'Return All',
				name: 'returnAll',
				type: 'boolean',
				displayOptions: { show: { resource: ['generation'], operation: ['getMany'] } },
				default: false,
				description: 'Whether to return all results or only up to a given limit',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				displayOptions: {
					show: { resource: ['generation'], operation: ['getMany'], returnAll: [false] },
				},
				default: 50,
				description: 'Max number of results to return',
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['generation'], operation: ['getMany'] } },
				options: [
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						options: [
							{ name: 'Error', value: 'error' },
							{ name: 'Pending', value: 'pending' },
							{ name: 'Processing', value: 'processing' },
							{ name: 'Success', value: 'success' },
							{ name: 'Uploading', value: 'uploading' },
						],
						default: 'success',
						description: 'Only return generations with this status',
					},
				],
			},

			// ---------------------------------------------------------- tool:get
			{
				displayName: 'Tool Name or ID',
				name: 'toolSlug',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTools' },
				required: true,
				displayOptions: { show: { resource: ['tool'], operation: ['get'] } },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},

			// ------------------------------------------------------ file:upload
			{
				displayName: 'Input Binary Field',
				name: 'binaryProperty',
				type: 'string',
				required: true,
				displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
				default: 'data',
				hint: 'The name of the input binary field containing the file to upload',
				description: 'Images, videos, audio and 3D models are supported',
			},
			{
				displayName: 'Keep in Library',
				name: 'keepInLibrary',
				type: 'boolean',
				displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
				default: true,
				description: 'Whether the file shows up in your Artificial Studio library',
			},
		],
	};

	methods = {
		loadOptions: {
			async getTools(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await apiRequest<{ data: ToolSummary[] }>(this, 'GET', '/tools');
				return (response.data ?? [])
					.map((tool) => ({
						name: `${tool.name} (${tool.outputType ?? tool.type ?? 'tool'})`,
						value: tool.slug,
						description: tool.description ?? '',
					}))
					.sort((a, b) => a.name.localeCompare(b.name));
			},

			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const options: INodePropertyOptions[] = [{ name: 'Tool Default', value: '' }];
				const tool = this.getCurrentNodeParameter('tool') as string;
				if (!tool) return options;

				const detail = await getToolDetail(this, tool);
				for (const model of detail.models ?? []) {
					options.push({
						name:
							model.cost !== undefined
								? `${model.name} (${model.cost} credits / ${model.costUnit ?? 'generation'})`
								: model.name,
						value: model.slug,
					});
				}
				return options;
			},

			async getMediaFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const tool = this.getCurrentNodeParameter('tool') as string;
				if (!tool) return [];
				const model = (this.getCurrentNodeParameter('model') as string) || undefined;
				return mediaFieldOptions(await getToolDetail(this, tool), model);
			},
		},

		resourceMapping: {
			async getModelParameters(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const tool = this.getCurrentNodeParameter('tool') as string;
				if (!tool) return { fields: [] };
				const model = (this.getCurrentNodeParameter('model') as string) || undefined;
				return { fields: parameterFields(await getToolDetail(this, tool), model) };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		if (
			resource === 'generation' &&
			operation === 'run' &&
			this.getNodeParameter('wait', 0) === 'webhook'
		) {
			return await runAndWaitForWebhook.call(this, items.length);
		}

		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				let results: INodeExecutionData[];

				if (resource === 'generation' && operation === 'run') {
					results = [await runTool.call(this, i)];
				} else if (resource === 'generation' && operation === 'get') {
					results = [await getGeneration.call(this, i)];
				} else if (resource === 'generation' && operation === 'getMany') {
					results = await getManyGenerations.call(this, i);
				} else if (resource === 'tool' && operation === 'get') {
					const slug = this.getNodeParameter('toolSlug', i) as string;
					const detail = await getToolDetail(this, slug);
					results = [{ json: detail as unknown as IDataObject, pairedItem: { item: i } }];
				} else if (resource === 'tool' && operation === 'getMany') {
					const response = await apiRequest<{ data: ToolSummary[] }>(this, 'GET', '/tools');
					results = (response.data ?? []).map((tool) => ({
						json: tool as unknown as IDataObject,
						pairedItem: { item: i },
					}));
				} else if (resource === 'file' && operation === 'upload') {
					const property = this.getNodeParameter('binaryProperty', i) as string;
					const keep = this.getNodeParameter('keepInLibrary', i, true) as boolean;
					const uploaded = await uploadBinary(this, i, property, keep);
					results = [{ json: uploaded as unknown as IDataObject, pairedItem: { item: i } }];
				} else if (resource === 'account' && operation === 'get') {
					const account = await apiRequest(this, 'GET', '/account');
					results = [{ json: account, pairedItem: { item: i } }];
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for resource "${resource}"`,
						{ itemIndex: i },
					);
				}

				returnData.push(...results);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw toItemError(this, error, i);
			}
		}

		return [returnData];
	}

	/**
	 * Resume point for "Wait For Webhook". The callback is only a wake-up call:
	 * the generation is re-read from the API so the result cannot be spoofed by
	 * whoever discovers the resume URL.
	 */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const headers = this.getHeaderData() as IDataObject;
		const body = this.getBodyData() as IDataObject;

		if (headers['x-webhook-source'] !== 'artificial-studio' || typeof body.id !== 'string') {
			throw new NodeOperationError(
				this.getNode(),
				'Ignored a resume request that did not come from Artificial Studio',
			);
		}

		const generation = await withRetry(() =>
			apiRequest<Generation>(this, 'GET', `/generations/${encodeURIComponent(body.id as string)}`),
		);

		if (generation.status === 'error') {
			throw new NodeOperationError(
				this.getNode(),
				`Generation ${generation.id} failed: ${generation.error ?? 'unknown error'}`,
			);
		}
		if (generation.status !== 'success') {
			throw new NodeOperationError(
				this.getNode(),
				`Generation ${generation.id} is still ${generation.status}`,
			);
		}

		const options = this.getNodeParameter('options', {}) as RunOptions;
		return { workflowData: [[await toOutputItem(this, generation, options)]] };
	}
}

// ------------------------------------------------------------------ helpers

async function toOutputItem(
	ctx: IExecuteFunctions | IWebhookFunctions,
	generation: Generation,
	options: RunOptions,
	itemIndex = 0,
): Promise<INodeExecutionData> {
	const item: INodeExecutionData = {
		json: generation as unknown as IDataObject,
		pairedItem: { item: itemIndex },
	};
	if (options.download) {
		const binary = await downloadOutput(ctx, generation);
		if (binary) item.binary = { [options.binaryProperty || 'data']: binary };
	}
	return item;
}

async function buildRunBody(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<{ tool: string; input: IDataObject; webhook?: string }> {
	const tool = this.getNodeParameter('tool', itemIndex) as string;
	const model = this.getNodeParameter('model', itemIndex, '') as string;
	const prompt = this.getNodeParameter('prompt', itemIndex, '') as string;
	const options = this.getNodeParameter('options', itemIndex, {}) as RunOptions;
	const media = this.getNodeParameter('mediaInputs', itemIndex, {}) as { inputs?: MediaInput[] };
	const mapped = this.getNodeParameter('parameters', itemIndex, {
		value: {},
	}) as ResourceMapperValue;

	if (!tool) {
		throw new NodeOperationError(this.getNode(), 'Pick a tool to run', { itemIndex });
	}

	const detail: ToolDetail = await getToolDetail(this, tool);
	const { properties } = resolveSchema(detail, model || undefined);

	let input: IDataObject;
	try {
		input = coerceParameters((mapped?.value ?? {}) as IDataObject, properties);
	} catch (error) {
		throw new NodeOperationError(this.getNode(), (error as Error).message, { itemIndex });
	}

	if (prompt) input.prompt = prompt;
	if (model) input.model = model;

	for (const entry of media.inputs ?? []) {
		if (!entry.field) {
			throw new NodeOperationError(
				this.getNode(),
				'Each media input needs a field. Pick which input of the model the file goes to.',
				{ itemIndex },
			);
		}

		let value: string;
		if (entry.source === 'binary') {
			const uploaded: UploadedFile = await uploadBinary(
				this,
				itemIndex,
				entry.binaryProperty || 'data',
				options.keepUploads ?? true,
			);
			value = uploaded.url;
		} else {
			value = (entry.url ?? '').trim();
			if (!value) {
				throw new NodeOperationError(this.getNode(), `Media input "${entry.field}" has no URL`, {
					itemIndex,
				});
			}
		}

		const isList = properties[entry.field]?.type === 'array' || /_urls$/.test(entry.field);
		if (isList) {
			const existing = input[entry.field] === undefined ? [] : toArray(input[entry.field]);
			input[entry.field] = [...existing, value];
		} else {
			input[entry.field] = value;
		}
	}

	const body: { tool: string; input: IDataObject; webhook?: string } = { tool, input };
	if (options.webhookUrl) body.webhook = options.webhookUrl;
	return body;
}

async function runTool(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData> {
	const wait = this.getNodeParameter('wait', itemIndex, 'poll') as string;
	const options = this.getNodeParameter('options', itemIndex, {}) as RunOptions;
	const body = await buildRunBody.call(this, itemIndex);

	const started = await withRetry(
		() => apiRequest<Generation>(this, 'POST', '/run', { body: body as unknown as IDataObject }),
		{ attempts: 3, baseDelayMs: 3000 },
	);
	if (wait === 'none') {
		return { json: started as unknown as IDataObject, pairedItem: { item: itemIndex } };
	}

	const timeoutMs = (this.getNodeParameter('timeout', itemIndex, 600) as number) * 1000;
	const finished = await waitForGeneration(this, started.id, timeoutMs);
	return await toOutputItem(this, finished, options, itemIndex);
}

async function runAndWaitForWebhook(
	this: IExecuteFunctions,
	itemCount: number,
): Promise<INodeExecutionData[][]> {
	if (itemCount !== 1) {
		throw new NodeOperationError(
			this.getNode(),
			'"Wait For Webhook" handles one item per execution',
			{
				description:
					'Put a "Loop Over Items" node before this one, or switch "Wait For Result" to "Poll Until Done"',
			},
		);
	}

	const resumeUrl = this.evaluateExpression('{{ $execution.resumeUrl }}', 0);
	if (typeof resumeUrl !== 'string' || !/^https?:\/\//.test(resumeUrl)) {
		throw new NodeOperationError(
			this.getNode(),
			'Could not determine the URL Artificial Studio should call to resume this execution',
			{
				description:
					'"Wait For Webhook" needs an n8n instance reachable from the internet (n8n Cloud, or WEBHOOK_URL set on self-hosted). Use "Poll Until Done" instead.',
			},
		);
	}

	const body = await buildRunBody.call(this, 0);
	body.webhook = resumeUrl;

	const started = await withRetry(
		() => apiRequest<Generation>(this, 'POST', '/run', { body: body as unknown as IDataObject }),
		{ attempts: 3, baseDelayMs: 3000 },
	);

	await this.putExecutionToWait(WAIT_INDEFINITELY);
	return [[{ json: started as unknown as IDataObject, pairedItem: { item: 0 } }]];
}

async function getGeneration(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData> {
	const id = (this.getNodeParameter('generationId', itemIndex) as string).trim();
	const options = this.getNodeParameter('options', itemIndex, {}) as RunOptions;
	const generation = await apiRequest<Generation>(
		this,
		'GET',
		`/generations/${encodeURIComponent(id)}`,
	);
	return await toOutputItem(this, generation, options, itemIndex);
}

async function getManyGenerations(
	this: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
	const filters = this.getNodeParameter('filters', itemIndex, {}) as { status?: string };

	const pageSize = 100;
	const collected: Generation[] = [];
	let offset = 0;
	let hasMore = true;

	while (hasMore && (returnAll || collected.length < limit)) {
		const qs: IDataObject = {
			limit: returnAll ? pageSize : Math.min(pageSize, limit - collected.length),
			offset,
		};
		if (filters.status) qs.status = filters.status;

		const page = await apiRequest<GenerationList>(this, 'GET', '/generations', { qs });
		const rows = page.data ?? [];
		collected.push(...rows);
		offset += rows.length;
		hasMore = rows.length > 0 && !!page.pagination?.hasMore;
	}

	return collected.map((generation) => ({
		json: generation as unknown as IDataObject,
		pairedItem: { item: itemIndex },
	}));
}
