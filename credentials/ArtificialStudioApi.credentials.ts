import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class ArtificialStudioApi implements ICredentialType {
	name = 'artificialStudioApi';

	displayName = 'Artificial Studio API';

	documentationUrl = 'https://docs.artificialstudio.ai/getting-started/authentication';

	icon: Icon = {
		light: 'file:../nodes/ArtificialStudio/artificialstudio.svg',
		dark: 'file:../nodes/ArtificialStudio/artificialstudio.dark.svg',
	};

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Create one at artificialstudio.ai → Settings → API Keys. It starts with "prod_".',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.artificialstudio.ai',
			description: 'Leave as is. Only change it to point at a staging environment.',
		},
	];

	// Keys go raw in the Authorization header, without a "Bearer" prefix.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/account',
		},
	};
}
