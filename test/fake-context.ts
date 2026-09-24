import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodeExecutionData,
} from 'n8n-workflow';

/** A response the fake HTTP layer returns, or an error it throws (a network failure). */
export type FakeResponse =
	| { statusCode: number; body?: unknown; headers?: Record<string, string> }
	| Error;

export interface FakeCall {
	credentialType: string;
	options: IHttpRequestOptions;
}

export interface FakeOptions {
	parameters: IDataObject;
	items?: INodeExecutionData[];
	responses?: FakeResponse[];
	continueOnFail?: boolean;
	toolExecution?: boolean;
	credentials?: IDataObject;
}

/** Look up `a.b.c` in the parameters; a function value is called with the item index (a per-item expression). */
function lookup(parameters: IDataObject, path: string, itemIndex: number): unknown {
	let value: unknown = parameters;
	for (const key of path.split('.')) {
		if (value === null || typeof value !== 'object') return undefined;
		value = (value as IDataObject)[key];
	}
	return typeof value === 'function' ? (value as (i: number) => unknown)(itemIndex) : value;
}

/** A resource locator value ({ __rl, mode, value }) resolves to its value, like n8n's extractValue. */
function locatorValue(value: unknown): unknown {
	return value && typeof value === 'object' && 'value' in value
		? (value as { value: unknown }).value
		: value;
}

/**
 * A minimal IExecuteFunctions: node parameters, input items, and an HTTP layer that returns queued
 * responses and records every request. Enough to run the node's execute() without n8n.
 */
export function fakeContext(options: FakeOptions) {
	const calls: FakeCall[] = [];
	const responses = [...(options.responses ?? [])];
	const node: INode = {
		id: 'node-1',
		name: 'Hesperan',
		type: 'n8n-nodes-hesperan.hesperan',
		typeVersion: 1,
		position: [0, 0],
		parameters: options.parameters as INode['parameters'],
	};
	const items = options.items ?? [{ json: {} }];

	const context = {
		getInputData: () => items,
		getNode: () => node,
		getNodeParameter: (
			name: string,
			itemIndex: number,
			fallback?: unknown,
			extra?: { extractValue?: boolean },
		) => {
			const value = lookup(options.parameters, name, itemIndex);
			if (value === undefined) {
				if (fallback === undefined) throw new Error(`missing parameter ${name}`);
				return fallback;
			}
			return extra?.extractValue ? locatorValue(value) : value;
		},
		getCurrentNodeParameter: (name: string, extra?: { extractValue?: boolean }) => {
			const value = lookup(options.parameters, name, 0);
			return extra?.extractValue ? locatorValue(value) : value;
		},
		continueOnFail: () => options.continueOnFail === true,
		isToolExecution: () => options.toolExecution === true,
		getCredentials: async () =>
			options.credentials ?? { apiKey: 'hsp_test', baseUrl: 'https://api.example.test/' },
		helpers: {
			httpRequestWithAuthentication: async (
				credentialType: string,
				requestOptions: IHttpRequestOptions,
			) => {
				calls.push({ credentialType, options: requestOptions });
				const next = responses.shift();
				if (next === undefined) throw new Error('no fake response queued');
				if (next instanceof Error) throw next;
				return { headers: {}, ...next };
			},
		},
	};

	return {
		context: context as unknown as IExecuteFunctions,
		loadOptionsContext: context as unknown as ILoadOptionsFunctions,
		calls,
		remaining: () => responses.length,
	};
}
