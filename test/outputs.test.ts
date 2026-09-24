import { NodeHelpers, Workflow, type INode, type INodeParameters, type INodeTypes } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { Hesperan } from '../nodes/Hesperan/Hesperan.node';
import { configuredOutputs } from '../nodes/Hesperan/outputs';

const nodeType = new Hesperan();

/** Resolve the node's outputs the way n8n does: through its expression engine, with defaults applied. */
function outputsInN8n(parameters: INodeParameters) {
	const nodeTypes: INodeTypes = {
		getByName: () => nodeType,
		getByNameAndVersion: () => nodeType,
		getKnownTypes: () => ({}),
	};
	const node: INode = {
		id: 'node-1',
		name: 'Hesperan',
		type: 'n8n-nodes-hesperan.hesperan',
		typeVersion: 1,
		position: [0, 0],
		parameters,
	};
	const workflow = new Workflow({ nodes: [node], connections: {}, active: false, nodeTypes });
	return NodeHelpers.getNodeOutputs(workflow, workflow.getNode('Hesperan')!, nodeType.description);
}

const names = (outputs: unknown) =>
	(outputs as Array<{ displayName?: string } | string>).map((o) => (typeof o === 'string' ? o : o.displayName ?? ''));

const question = (fields: Record<string, unknown>) => ({ questions: { question: [fields] } });

describe('configuredOutputs', () => {
	it('gives Decide an Auto and a Review output, also with default parameters', () => {
		expect(names(configuredOutputs({}))).toEqual(['Auto', 'Review']);
		expect(names(configuredOutputs({ resource: 'decision', operation: 'decide' }))).toEqual(['Auto', 'Review']);
	});

	it('gives Report Outcome and a plain Ask one output', () => {
		expect(configuredOutputs({ resource: 'decision', operation: 'reportOutcome' })).toHaveLength(1);
		expect(configuredOutputs({ resource: 'question', operation: 'ask' })).toHaveLength(1);
	});

	it('routes Ask by the options of the first choice question', () => {
		const outputs = configuredOutputs({
			resource: 'question',
			operation: 'ask',
			routeByAnswer: true,
			...question({ name: 'team', type: 'choice', options: 'billing: money\n\nshipping\n technical : bugs \nbilling' }),
		});
		expect(names(outputs)).toEqual(['billing', 'shipping', 'technical']);
	});

	it('routes a yes/no question to Yes and No', () => {
		const outputs = configuredOutputs({
			resource: 'question',
			operation: 'ask',
			routeByAnswer: true,
			...question({ name: 'spam', type: 'noul' }),
		});
		expect(names(outputs)).toEqual(['Yes', 'No']);
	});

	it('does not route scores, expressions, JSON questions or a single option', () => {
		const base = { resource: 'question', operation: 'ask', routeByAnswer: true };
		expect(configuredOutputs({ ...base, ...question({ name: 'u', type: 'score', levels: 'a\nb' }) })).toHaveLength(1);
		expect(configuredOutputs({ ...base, ...question({ name: 't', options: '={{ $json.teams }}' }) })).toHaveLength(1);
		expect(configuredOutputs({ ...base, questionsMode: 'json' })).toHaveLength(1);
		expect(configuredOutputs({ ...base, ...question({ name: 't', options: 'only' }) })).toHaveLength(1);
		expect(configuredOutputs({ ...base, routeByAnswer: false, ...question({ name: 't', options: 'a\nb' }) })).toHaveLength(1);
	});
});

describe('outputs expression in the node description', () => {
	it('embeds the function as an n8n expression', () => {
		expect(nodeType.description.outputs).toMatch(/^=\{\{\(.*\)\(\$parameter\)\}\}$/s);
	});

	it('is evaluated by n8n itself to Auto and Review for Decide', () => {
		expect(names(outputsInN8n({ resource: 'decision', operation: 'decide', profile: 'x' }))).toEqual([
			'Auto',
			'Review',
		]);
	});

	it('is evaluated by n8n itself to one output per routed option', () => {
		const outputs = outputsInN8n({
			resource: 'question',
			operation: 'ask',
			routeByAnswer: true,
			questions: { question: [{ name: 'team', type: 'choice', instructions: 'Which team?', options: 'a\nb\nc' }] },
		});
		expect(names(outputs)).toEqual(['a', 'b', 'c']);
	});

	it('is evaluated by n8n itself to one output for Report Outcome', () => {
		expect(outputsInN8n({ resource: 'decision', operation: 'reportOutcome' })).toHaveLength(1);
	});
});
