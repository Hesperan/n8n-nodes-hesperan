import { describe, expect, it } from 'vitest';

import { HesperanApi } from '../credentials/HesperanApi.credentials';

const credential = new HesperanApi();

describe('Hesperan API credential', () => {
	it('sends the key as a bearer token', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
		});
	});

	it('keeps the key secret and defaults the base URL', () => {
		const apiKey = credential.properties.find((p) => p.name === 'apiKey');
		const baseUrl = credential.properties.find((p) => p.name === 'baseUrl');
		expect(apiKey?.typeOptions?.password).toBe(true);
		expect(baseUrl?.default).toBe('https://api.hesperan.com');
	});

	it('tests the key with the free GET /v1/me', () => {
		const { request, rules } = credential.test;
		expect(request).toMatchObject({ url: '/v1/me', method: 'GET' });
		expect(rules?.map((r) => r.properties.value)).toEqual([401, 404]);
	});
});
