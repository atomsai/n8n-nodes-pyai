import type {
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	IAuthenticateGeneric,
	INodeProperties,
} from 'n8n-workflow';

export class PyAiApi implements ICredentialType {
	name = 'pyAiApi';

	displayName = 'PyAI API';

	icon: Icon = { light: 'file:../nodes/PyAi/pyai.svg', dark: 'file:../nodes/PyAi/pyai.svg' };

	documentationUrl = 'https://docs.pyai.com/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.pyai.com',
			url: '/v1/me',
		},
	};
}
