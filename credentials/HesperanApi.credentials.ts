import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class HesperanApi implements ICredentialType {
	name = 'hesperanApi';

	displayName = 'Hesperan API';

	icon = {
		light: 'file:../nodes/Hesperan/hesperan.svg',
		dark: 'file:../nodes/Hesperan/hesperan.dark.svg',
	} as const;

	documentationUrl =
		'https://github.com/hesperan/n8n-nodes-hesperan?tab=readme-ov-file#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'hsp_…',
			description: 'An API key from the Hesperan console (starts with hsp_)',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.hesperan.com',
			description: 'Only change this if Hesperan gave you a different API address',
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

	/** GET /v1/me checks the key without calling the model; it is free and not metered. */
	test: ICredentialTestRequest = {
		request: {
			baseURL:
				'={{String($credentials.baseUrl || "https://api.hesperan.com").replace(/\\/+$/, "")}}',
			url: '/v1/me',
			method: 'GET',
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						'Hesperan rejected the API key. Check that it was copied completely and has not been revoked.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message:
						'No Hesperan API was found at this base URL. The default is https://api.hesperan.com.',
				},
			},
		],
	};
}
