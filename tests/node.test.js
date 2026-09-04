// Runs against the compiled output: `npm run build && npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dist = path.join(__dirname, '..', 'dist', 'nodes', 'ArtificialStudio');
const { ArtificialStudio } = require(path.join(dist, 'ArtificialStudio.node.js'));
const {
	coerceParameters,
	mediaFieldOptions,
	parameterFields,
	resolveSchema,
	toArray,
} = require(path.join(dist, 'GenericFunctions.js'));

const sampleTool = {
	slug: 'create-video',
	name: 'Create Video',
	models: [
		{
			slug: 'fast',
			name: 'Fast',
			cost: 10,
			inputSchema: {
				type: 'object',
				properties: {
					prompt: { type: 'string' },
					image_urls: { type: 'array', items: { type: 'string' }, inputType: 'gallery', fileType: 'image', label: 'Reference images' },
					audio_url: { type: 'string', fileType: 'audio', optional: true },
					duration: { type: 'number', default: 5, label: 'Duration' },
					aspect_ratio: { type: 'enum', enum: ['16:9', '9:16'], default: '16:9' },
					codec: {
						type: 'enum',
						enum: ['webm_vp9', 'mp4_h264'],
						default: 'webm_vp9',
						inputType: 'select',
						label: 'Format',
						options: [
							{ label: 'WebM (VP9)', value: 'webm_vp9' },
							{ label: 'MP4 (H.264)', value: 'mp4_h264' },
						],
					},
					loop: { type: 'boolean', optional: true },
					tags: { type: 'array', items: { type: 'string' }, optional: true },
					seed: { type: 'number' },
				},
				required: ['prompt', 'image_urls', 'seed'],
			},
		},
		{ slug: 'pro', name: 'Pro', cost: 40, inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
	],
};

test('node description is internally consistent', () => {
	const node = new ArtificialStudio();
	const { description, methods } = node;

	assert.equal(description.name, 'artificialStudio');
	assert.equal(description.usableAsTool, true);
	assert.equal(description.webhooks[0].restartWebhook, true);
	assert.equal(typeof node.execute, 'function');
	assert.equal(typeof node.webhook, 'function');

	const names = new Set(description.properties.map((p) => p.name));
	const loadMethods = new Set(Object.keys(methods.loadOptions));

	for (const prop of description.properties) {
		// Every displayOptions.show key must be a real top-level parameter.
		for (const key of Object.keys(prop.displayOptions?.show ?? {})) {
			assert.ok(names.has(key), `${prop.name}: displayOptions references unknown "${key}"`);
		}
		// Dynamic dropdowns must point at an existing loader.
		const method = prop.typeOptions?.loadOptionsMethod;
		if (method) assert.ok(loadMethods.has(method), `${prop.name}: missing loader ${method}`);
		// Option defaults must be one of the option values (dynamic lists load at runtime).
		if (prop.type === 'options' && !method) {
			const values = prop.options.map((o) => o.value);
			assert.ok(values.includes(prop.default), `${prop.name}: default "${prop.default}" not in options`);
		}
	}

	const mapper = description.properties.find((p) => p.type === 'resourceMapper');
	assert.ok(methods.resourceMapping[mapper.typeOptions.resourceMapper.resourceMapperMethod]);
});

test('resolveSchema prefers the selected model and falls back to the first one', () => {
	assert.deepEqual(Object.keys(resolveSchema(sampleTool, 'pro').properties), ['prompt']);
	assert.ok('duration' in resolveSchema(sampleTool).properties);
});

test('mediaFieldOptions lists file inputs and flags multi-file ones', () => {
	const options = mediaFieldOptions(sampleTool, 'fast');
	assert.deepEqual(
		options.map((o) => [o.value, o.name]),
		[
			['image_urls', 'Reference images (multiple)'],
			['audio_url', 'Audio URL'],
		],
	);
});

test('parameterFields skips prompt/model/media and types the rest', () => {
	const fields = parameterFields(sampleTool, 'fast');
	const byId = Object.fromEntries(fields.map((f) => [f.id, f]));

	assert.deepEqual(Object.keys(byId), ['duration', 'aspect_ratio', 'codec', 'loop', 'tags', 'seed']);
	assert.equal(byId.duration.type, 'number');
	assert.equal(byId.duration.displayName, 'Duration (default: 5)');
	assert.equal(byId.duration.required, false);
	assert.equal(byId.aspect_ratio.type, 'options');
	assert.deepEqual(byId.aspect_ratio.options.map((o) => o.value), ['16:9', '9:16']);
	// A model that labels its choices shows those labels, not the raw values.
	assert.deepEqual(
		byId.codec.options,
		[
			{ name: 'WebM (VP9)', value: 'webm_vp9' },
			{ name: 'MP4 (H.264)', value: 'mp4_h264' },
		],
	);
	assert.equal(byId.loop.type, 'boolean');
	assert.equal(byId.tags.type, 'string');
	assert.match(byId.tags.displayName, /comma-separated/);
	assert.equal(byId.seed.required, true);
});

test('coerceParameters drops empties and casts by schema type', () => {
	const { properties } = resolveSchema(sampleTool, 'fast');
	const input = coerceParameters(
		{ duration: '8', loop: 'true', tags: 'a, b ,c', aspect_ratio: '9:16', seed: '', extra: null },
		properties,
	);
	assert.deepEqual(input, { duration: 8, loop: true, tags: ['a', 'b', 'c'], aspect_ratio: '9:16' });
	assert.throws(() => coerceParameters({ duration: 'long' }, properties), /must be a number/);
});

test('toArray accepts arrays, JSON and comma lists', () => {
	assert.deepEqual(toArray(['x']), ['x']);
	assert.deepEqual(toArray('["x","y"]'), ['x', 'y']);
	assert.deepEqual(toArray('x, y'), ['x', 'y']);
	assert.deepEqual(toArray(3), [3]);
});
