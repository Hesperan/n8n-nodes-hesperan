import { NodeApiError, NodeOperationError, type IDataObject } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Hesperan } from '../nodes/Hesperan/Hesperan.node';
import { getProfileAnswers, searchProfiles } from '../nodes/Hesperan/profiles';
import { fakeContext, type FakeOptions } from './fake-context';

const waits = vi.hoisted(() => [] as number[]);
vi.mock('n8n-workflow', async (importOriginal) => ({
	...(await importOriginal<typeof import('n8n-workflow')>()),
	sleep: async (ms: number) => {
		waits.push(ms);
	},
}));

const node = new Hesperan();
const run = (options: FakeOptions) => {
	const fake = fakeContext(options);
	return { ...fake, result: node.execute.call(fake.context) };
};

const decision = (overrides: IDataObject = {}) => ({
	decision_id: 'd-1',
	profile: 'ticket-routing',
	decision: 'billing',
	confidence: 0.9931,
	action: 'auto',
	threshold: 0.962,
	target_precision: 0.99,
	calibration_version: 1,
	probabilities: { billing: 0.9931, shipping: 0.0069 },
	raw_probabilities: { billing: 0.9412, shipping: 0.0588 },
	...overrides,
});

const decide = (extra: IDataObject = {}): IDataObject => ({
	resource: 'decision',
	operation: 'decide',
	profile: { __rl: true, mode: 'list', value: 'ticket-routing' },
	stateSource: 'text',
	stateText: (i: number) => `ticket ${i}`,
	idempotencyKey: '',
	options: {},
	...extra,
});

beforeEach(() => {
	waits.length = 0;
});

describe('Decide', () => {
	it('sends auto decisions to the Auto output and the rest to Review', async () => {
		const { result, calls } = run({
			parameters: decide(),
			items: [{ json: { id: 1 } }, { json: { id: 2 } }, { json: { id: 3 } }],
			responses: [
				{ statusCode: 200, body: decision() },
				{ statusCode: 200, body: decision({ decision_id: 'd-2', action: 'review', confidence: 0.61 }) },
				{ statusCode: 200, body: decision({ decision_id: 'd-3', action: 'something new' }) },
			],
		});
		const [auto, review] = await result;
		expect(auto.map((i) => i.json.id)).toEqual([1]);
		expect(review.map((i) => i.json.id)).toEqual([2, 3]);
		expect(auto[0].json.hesperan).toMatchObject({ decision: 'billing', action: 'auto', decision_id: 'd-1', replayed: false });
		expect(auto[0].pairedItem).toEqual({ item: 0 });
		expect(review[1].pairedItem).toEqual({ item: 2 });

		expect(calls).toHaveLength(3);
		expect(calls[0].credentialType).toBe('hesperanApi');
		expect(calls[0].options).toMatchObject({
			method: 'POST',
			url: 'https://api.example.test/v1/decide/ticket-routing',
			body: { state: 'ticket 0' },
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});
		expect(calls[0].options.headers).not.toHaveProperty('Idempotency-Key');
	});

	it('sends the Idempotency-Key and reports a replayed decision', async () => {
		const { result, calls } = run({
			parameters: decide({ idempotencyKey: 'ticket-4812' }),
			responses: [{ statusCode: 200, body: decision(), headers: { 'Idempotent-Replayed': 'true' } }],
		});
		const [auto] = await result;
		expect(calls[0].options.headers).toMatchObject({ 'Idempotency-Key': 'ticket-4812' });
		expect(auto[0].json.hesperan).toMatchObject({ replayed: true });
	});

	it('refuses an invalid Idempotency-Key before calling the API', async () => {
		const { result, calls } = run({ parameters: decide({ idempotencyKey: 'has spaces' }) });
		await expect(result).rejects.toThrow(/Idempotency Key/);
		expect(calls).toHaveLength(0);
	});

	it('sends the whole item, or parsed JSON, as state', async () => {
		const item = run({
			parameters: decide({ stateSource: 'item' }),
			items: [{ json: { subject: 'Refund', body: 'charged twice' } }],
			responses: [{ statusCode: 200, body: decision() }],
		});
		await item.result;
		expect(item.calls[0].options.body).toEqual({ state: { subject: 'Refund', body: 'charged twice' } });

		const json = run({
			parameters: decide({ stateSource: 'json', stateJson: '{"subject":"Refund"}' }),
			responses: [{ statusCode: 200, body: decision() }],
		});
		await json.result;
		expect(json.calls[0].options.body).toEqual({ state: { subject: 'Refund' } });
	});

	it('refuses an empty state or invalid JSON without calling the API', async () => {
		const empty = run({ parameters: decide({ stateText: '  ' }) });
		await expect(empty.result).rejects.toThrow('The state is empty');
		const invalid = run({ parameters: decide({ stateSource: 'json', stateJson: '{nope' }) });
		await expect(invalid.result).rejects.toThrow('State (JSON) is not valid JSON');
		expect(empty.calls.length + invalid.calls.length).toBe(0);
	});

	it('puts the result into a chosen field, or merges it into the item', async () => {
		const field = run({
			parameters: decide({ options: { outputField: 'triage' } }),
			items: [{ json: { id: 7 } }],
			responses: [{ statusCode: 200, body: decision() }],
		});
		expect((await field.result)[0][0].json).toMatchObject({ id: 7, triage: { decision: 'billing' } });

		const merged = run({
			parameters: decide({ options: { outputField: '' } }),
			items: [{ json: { id: 7 } }],
			responses: [{ statusCode: 200, body: decision() }],
		});
		expect((await merged.result)[0][0].json).toMatchObject({ id: 7, decision: 'billing', action: 'auto' });
	});

	it('uses the base URL from the credential without a trailing slash and escapes the slug', async () => {
		const { result, calls } = run({
			parameters: decide({ profile: { __rl: true, mode: 'slug', value: 'a b/c' } }),
			credentials: { apiKey: 'hsp_x', baseUrl: 'https://gateway.example.test///' },
			responses: [{ statusCode: 200, body: decision() }],
		});
		await result;
		expect(calls[0].options.url).toBe('https://gateway.example.test/v1/decide/a%20b%2Fc');
	});
});

describe('errors', () => {
	const failWith = async (response: { statusCode: number; body?: unknown; headers?: Record<string, string> }, extra: IDataObject = {}) => {
		const { result, calls } = run({ parameters: decide(extra), responses: [response, response, response, response] });
		const error = await result.then(
			() => null,
			(e: unknown) => e,
		);
		return { error: error as NodeApiError, calls };
	};

	it('says plainly that the API is not open yet and does not retry', async () => {
		const { error, calls } = await failWith({
			statusCode: 503,
			body: { error: 'the Hesperan API opens soon — no model is connected yet; nothing was charged' },
		});
		expect(error).toBeInstanceOf(NodeApiError);
		expect(error.message).toBe('The Hesperan API is not open yet: no model is connected');
		expect(error.description).toMatch(/Nothing was charged\. Retrying will not help/);
		expect(error.httpCode).toBe('503');
		expect(calls).toHaveLength(1);
		expect(waits).toEqual([]);
	});

	it('retries a starting model after Retry-After and then succeeds', async () => {
		const { result, calls } = run({
			parameters: decide(),
			responses: [
				{ statusCode: 503, body: { error: 'model is starting — retry in about 30 seconds' }, headers: { 'retry-after': '30' } },
				{ statusCode: 200, body: decision() },
			],
		});
		const [auto] = await result;
		expect(auto).toHaveLength(1);
		expect(calls).toHaveLength(2);
		expect(waits).toHaveLength(1);
		expect(waits[0]).toBeGreaterThanOrEqual(30_000);
		expect(waits[0]).toBeLessThanOrEqual(60_000);
	});

	it('retries a rate limit at most 3 times, then explains it', async () => {
		const { error, calls } = await failWith({ statusCode: 429, body: { error: 'rate limit exceeded' }, headers: { 'Retry-After': '2' } });
		expect(calls).toHaveLength(4);
		expect(waits).toHaveLength(3);
		expect(error.message).toBe('Hesperan rate limit reached');
		expect(error.description).toContain('Retry after 2 s');
	});

	it('does not retry when retries are switched off', async () => {
		const { error, calls } = await failWith({ statusCode: 502, body: { error: 'model unavailable' } }, { options: { retry: false } });
		expect(calls).toHaveLength(1);
		expect(error.message).toBe('The Hesperan model could not answer');
		expect(error.description).toContain('Nothing was charged');
	});

	it('explains a used-up allowance (402) without retrying', async () => {
		const { error, calls } = await failWith({
			statusCode: 402,
			body: { error: 'free allowance used up — top up your balance or choose a plan' },
		});
		expect(calls).toHaveLength(1);
		expect(error.message).toBe('Hesperan: free allowance used up — top up your balance or choose a plan');
		expect(error.description).toMatch(/Nothing was charged/);
	});

	it('explains a rejected key (401) and an unknown profile (404)', async () => {
		expect((await failWith({ statusCode: 401, body: { error: 'unauthorized' } })).error.message).toBe(
			'Hesperan rejected the API key',
		);
		expect((await failWith({ statusCode: 404, body: { error: 'unknown profile' } })).error.message).toBe(
			'Unknown decision profile "ticket-routing"',
		);
	});

	it('passes 409 messages through', async () => {
		const { error } = await failWith({ statusCode: 409, body: { error: 'profile has no calibration yet' } });
		expect(error.message).toBe('Hesperan: profile has no calibration yet');
	});

	it('wraps network failures', async () => {
		const { result } = run({ parameters: decide(), responses: [new Error('ECONNREFUSED')] });
		await expect(result).rejects.toThrow('Could not reach the Hesperan API');
	});

	it('with "continue on fail" sends failed decisions to Review with the error', async () => {
		const { result } = run({
			parameters: decide(),
			continueOnFail: true,
			items: [{ json: { id: 1 } }, { json: { id: 2 } }],
			responses: [
				{ statusCode: 402, body: { error: 'free allowance used up — top up your balance or choose a plan' } },
				{ statusCode: 200, body: decision() },
			],
		});
		const [auto, review] = await result;
		expect(auto.map((i) => i.json.id)).toEqual([2]);
		expect(review).toHaveLength(1);
		expect(review[0].json).toMatchObject({
			id: 1,
			hesperan: { error: 'Hesperan: free allowance used up — top up your balance or choose a plan', status: 402 },
		});
		expect(review[0].error).toBeInstanceOf(NodeApiError);
		expect(review[0].pairedItem).toEqual({ item: 0 });
	});

	it('with "continue on fail" keeps configuration errors on the item', async () => {
		const { result } = run({ parameters: decide({ profile: { __rl: true, mode: 'slug', value: '' } }), continueOnFail: true });
		const [, review] = await result;
		expect(review[0].error).toBeInstanceOf(NodeOperationError);
		expect(review[0].json.hesperan).toMatchObject({ error: 'Enter the slug of a decision profile' });
	});
});

describe('Report Outcome', () => {
	const report = (extra: IDataObject = {}): IDataObject => ({
		resource: 'decision',
		operation: 'reportOutcome',
		decisionId: 'd-1',
		actual: 'billing',
		options: {},
		...extra,
	});

	it('posts the outcome and returns one output', async () => {
		const { result, calls } = run({
			parameters: report(),
			items: [{ json: { ticket: 4812 } }],
			responses: [{ statusCode: 200, body: { ok: true, duplicate: true } }],
		});
		const out = await result;
		expect(out).toHaveLength(1);
		expect(out[0][0].json).toEqual({
			ticket: 4812,
			hesperanOutcome: { decision_id: 'd-1', actual: 'billing', ok: true, duplicate: true },
		});
		expect(calls[0].options).toMatchObject({
			url: 'https://api.example.test/v1/outcomes',
			body: { decision_id: 'd-1', actual: 'billing' },
		});
	});

	it('explains a conflicting outcome (409) and an unknown decision (404)', async () => {
		const conflict = run({
			parameters: report(),
			responses: [{ statusCode: 409, body: { error: 'an outcome was already reported for this decision: shipping' } }],
		});
		await expect(conflict.result).rejects.toMatchObject({
			message: 'Hesperan: an outcome was already reported for this decision: shipping',
			description: expect.stringContaining('Each decision takes one outcome'),
		});
		const unknown = run({ parameters: report(), responses: [{ statusCode: 404, body: { error: 'unknown decision' } }] });
		await expect(unknown.result).rejects.toThrow('Unknown decision ID');
	});

	it('requires a decision ID and an answer', async () => {
		await expect(run({ parameters: report({ decisionId: ' ' }) }).result).rejects.toThrow('Enter the decision ID');
		await expect(run({ parameters: report({ actual: '' }) }).result).rejects.toThrow('Enter the actual answer');
	});
});

describe('Ask', () => {
	const ask = (extra: IDataObject = {}): IDataObject => ({
		resource: 'question',
		operation: 'ask',
		stateSource: 'text',
		stateText: 'My parcel has been on its way for a week',
		questionsMode: 'fields',
		routeByAnswer: false,
		questions: {
			question: [
				{ name: 'team', type: 'choice', instructions: 'Which team?', options: 'billing: money\nshipping: delivery\ntechnical' },
				{ name: 'urgent', type: 'noul', instructions: 'The customer is upset.', yesMeans: 'angry', noMeans: '' },
				{ name: 'priority', type: 'score', instructions: 'How urgent?', levels: 'low\nmedium\nhigh' },
			],
		},
		options: {},
		...extra,
	});

	const answers = (team: string, urgent = 0.2) => ({
		model: 'hesperan-1',
		answers: {
			team: { type: 'choice', choice: team, probabilities: { billing: 0.1, shipping: 0.8, technical: 0.1 } },
			urgent: { type: 'noul', noul: urgent },
			priority: { type: 'score', score: 1.2, probabilities: { '0': 0.2, '1': 0.4, '2': 0.4 } },
		},
		usage: { input_tokens: 120 },
		timing_ms: 12,
	});

	it('builds typed questions and returns the answers', async () => {
		const { result, calls } = run({ parameters: ask(), responses: [{ statusCode: 200, body: answers('shipping') }] });
		const out = await result;
		expect(out).toHaveLength(1);
		expect(out[0][0].json.hesperan).toMatchObject({ answers: { team: { choice: 'shipping' } } });
		expect(calls[0].options.url).toBe('https://api.example.test/v1/systemone');
		expect(calls[0].options.body).toEqual({
			state: 'My parcel has been on its way for a week',
			questions: {
				team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'money', shipping: 'delivery', technical: '' } },
				urgent: { type: 'noul', instructions: 'The customer is upset.', criteria: { true: 'angry' } },
				priority: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'medium', 'high'] },
			},
		});
	});

	it('routes items by the first answer when asked to', async () => {
		const { result } = run({
			parameters: ask({ routeByAnswer: true }),
			items: [{ json: { n: 1 } }, { json: { n: 2 } }],
			responses: [
				{ statusCode: 200, body: answers('technical') },
				{ statusCode: 200, body: answers('billing') },
			],
		});
		const [billing, shipping, technical] = await result;
		expect(billing.map((i) => i.json.n)).toEqual([2]);
		expect(shipping).toEqual([]);
		expect(technical.map((i) => i.json.n)).toEqual([1]);
	});

	it('routes a first yes/no question to Yes or No', async () => {
		const parameters = ask({ routeByAnswer: true });
		const list = (parameters.questions as { question: IDataObject[] }).question;
		(parameters.questions as { question: IDataObject[] }).question = [list[1], list[0]];
		const { result } = run({
			parameters,
			items: [{ json: { n: 1 } }, { json: { n: 2 } }],
			responses: [
				{ statusCode: 200, body: answers('billing', 0.5) },
				{ statusCode: 200, body: answers('billing', 0.49) },
			],
		});
		const [yes, no] = await result;
		expect(yes.map((i) => i.json.n)).toEqual([1]);
		expect(no.map((i) => i.json.n)).toEqual([2]);
	});

	it('refuses routing when the first question cannot be routed', async () => {
		const parameters = ask({ routeByAnswer: true });
		(parameters.questions as { question: IDataObject[] }).question = [
			{ name: 'priority', type: 'score', instructions: 'How urgent?', levels: 'low\nhigh' },
		];
		await expect(run({ parameters }).result).rejects.toThrow('Route by First Answer');
	});

	it('accepts questions as JSON', async () => {
		const questions = { spam: { type: 'noul', instructions: 'This is spam.' } };
		const { result, calls } = run({
			parameters: ask({ questionsMode: 'json', questionsJson: JSON.stringify(questions) }),
			responses: [{ statusCode: 200, body: { model: 'hesperan-1', answers: { spam: { type: 'noul', noul: 0.1 } } } }],
		});
		await result;
		expect(calls[0].options.body).toMatchObject({ questions });
	});

	it('reports mistakes in the questions without calling the API', async () => {
		const cases: Array<[IDataObject[], string]> = [
			[[], 'add at least one question'],
			[[{ name: '', type: 'noul', instructions: 'x' }], 'needs a name'],
			[[{ name: 'a', type: 'choice', instructions: 'x', options: 'one' }], 'at least two options'],
			[[{ name: 'a', type: 'choice', instructions: 'x', options: 'one\none' }], 'listed twice'],
			[[{ name: 'a', type: 'score', instructions: 'x', levels: 'one' }], 'at least two levels'],
			[[{ name: 'a', type: 'noul', instructions: '' }], 'needs instructions'],
			[
				[
					{ name: 'a', type: 'noul', instructions: 'x' },
					{ name: 'a', type: 'noul', instructions: 'y' },
				],
				'two questions are named "a"',
			],
		];
		for (const [question, message] of cases) {
			const { result, calls } = run({ parameters: ask({ questions: { question } }) });
			await expect(result).rejects.toThrow(message);
			expect(calls).toHaveLength(0);
		}
		const badJson = run({ parameters: ask({ questionsMode: 'json', questionsJson: '{"a":{"type":"maybe"}}' }) });
		await expect(badJson.result).rejects.toThrow('needs "type"');
	});

	it('as an AI agent tool returns every item on one output', async () => {
		const { result } = run({
			parameters: ask({ routeByAnswer: true }),
			toolExecution: true,
			items: [{ json: { n: 1 } }, { json: { n: 2 } }],
			responses: [
				{ statusCode: 200, body: answers('technical') },
				{ statusCode: 200, body: answers('billing') },
			],
		});
		const out = await result;
		expect(out).toHaveLength(1);
		expect(out[0].map((i) => i.json.n).sort()).toEqual([1, 2]);
	});
});

describe('profile pickers', () => {
	const profiles = {
		profiles: [
			{ slug: 'ticket-routing', name: 'Ticket routing', type: 'choice', options: ['billing', 'shipping'], calibrated: true },
			{ slug: 'spam', name: 'spam', type: 'noul', options: ['true', 'false'], calibrated: false },
		],
	};

	it('lists and searches profiles with GET /v1/profiles', async () => {
		const all = fakeContext({ parameters: {}, responses: [{ statusCode: 200, body: profiles }] });
		expect(await searchProfiles.call(all.loadOptionsContext)).toEqual({
			results: [
				{ name: 'Ticket routing (ticket-routing)', value: 'ticket-routing' },
				{ name: 'spam – not calibrated yet', value: 'spam' },
			],
		});
		expect(all.calls[0].options).toMatchObject({ method: 'GET', url: 'https://api.example.test/v1/profiles' });
		expect(all.calls[0].options.body).toBeUndefined();

		const search = fakeContext({ parameters: {}, responses: [{ statusCode: 200, body: profiles }] });
		expect((await searchProfiles.call(search.loadOptionsContext, 'ROUT')).results.map((r) => r.value)).toEqual([
			'ticket-routing',
		]);
	});

	it('lists the answers of the chosen profile for Report Outcome', async () => {
		const choice = fakeContext({
			parameters: { profile: { __rl: true, mode: 'list', value: 'ticket-routing' } },
			responses: [{ statusCode: 200, body: profiles }],
		});
		expect(await getProfileAnswers.call(choice.loadOptionsContext)).toEqual([
			{ name: 'billing', value: 'billing' },
			{ name: 'shipping', value: 'shipping' },
		]);
		const yesNo = fakeContext({
			parameters: { profile: { __rl: true, mode: 'slug', value: 'spam' } },
			responses: [{ statusCode: 200, body: profiles }],
		});
		expect((await getProfileAnswers.call(yesNo.loadOptionsContext)).map((o) => o.name)).toEqual(['Yes (true)', 'No (false)']);
		const none = fakeContext({ parameters: {} });
		expect(await getProfileAnswers.call(none.loadOptionsContext)).toEqual([]);
		expect(none.calls).toHaveLength(0);
	});
});
