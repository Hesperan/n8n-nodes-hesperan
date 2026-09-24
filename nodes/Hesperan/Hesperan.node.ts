import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	askProperties,
	decideProperties,
	operationProperties,
	reportOutcomeProperties,
	resourceProperty,
} from './descriptions';
import { configuredOutputs } from './outputs';
import { getProfileAnswers, searchProfiles } from './profiles';
import {
	QuestionError,
	buildQuestions,
	parseJson,
	validateQuestionsJson,
	type QuestionFields,
} from './questions';
import { hesperanRequest } from './transport';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

interface Options {
	outputField?: string;
	retry?: boolean;
}

/** Put the result into the item: under `field`, or merged into the top level when `field` is empty. */
function withResult(item: INodeExecutionData, field: string, result: IDataObject): IDataObject {
	const json = { ...item.json };
	if (field) json[field] = result;
	else Object.assign(json, result);
	return json;
}

/** The state for item `i`, from the chosen source. */
function readState(
	this: IExecuteFunctions,
	i: number,
	item: INodeExecutionData,
	allowEmpty: boolean,
): unknown {
	const source = this.getNodeParameter('stateSource', i, 'text') as string;
	let state: unknown;
	if (source === 'item') {
		state = item.json;
	} else if (source === 'json') {
		state = this.getNodeParameter('stateJson', i, '{}');
		if (typeof state === 'string') {
			state = parseJson(state);
			if (state === undefined) {
				throw new NodeOperationError(this.getNode(), 'State (JSON) is not valid JSON', {
					itemIndex: i,
				});
			}
		}
		if (!state || typeof state !== 'object') {
			throw new NodeOperationError(this.getNode(), 'State (JSON) must be a JSON object or array', {
				itemIndex: i,
			});
		}
	} else {
		state = this.getNodeParameter('stateText', i, '');
		if (typeof state === 'number' || typeof state === 'boolean') state = String(state);
	}
	const empty =
		state === undefined ||
		state === null ||
		(typeof state === 'string' && state.trim() === '') ||
		(typeof state === 'object' && Object.keys(state as object).length === 0);
	if (empty && !allowEmpty) {
		throw new NodeOperationError(this.getNode(), 'The state is empty', {
			itemIndex: i,
			description:
				'Map the text or data to decide about into "State", or choose "Whole Input Item".',
		});
	}
	return state ?? '';
}

/** The questions for item `i`, from the list or from JSON. */
function readQuestions(this: IExecuteFunctions, i: number): IDataObject {
	const json = this.getNodeParameter('questionsMode', i, 'fields') === 'json';
	const input = json
		? this.getNodeParameter('questionsJson', i, '{}')
		: (this.getNodeParameter('questions.question', i, []) as QuestionFields[]);
	try {
		return json
			? validateQuestionsJson(input)
			: (buildQuestions((input as QuestionFields[]) ?? []) as unknown as IDataObject);
	} catch (error) {
		const message = error instanceof QuestionError ? error.message : String(error);
		throw new NodeOperationError(this.getNode(), `Questions: ${message}`, { itemIndex: i });
	}
}

/** Output index for "Route by First Answer": the option chosen, or Yes (0) / No (1). */
function routeIndex(
	this: IExecuteFunctions,
	body: IDataObject,
	name: string,
	keys: string[],
	i: number,
): number {
	const answers = (body.answers ?? {}) as IDataObject;
	const answer = (answers[name] ?? {}) as IDataObject;
	if (answer.type === 'noul' && typeof answer.noul === 'number') return answer.noul >= 0.5 ? 0 : 1;
	const index = typeof answer.choice === 'string' ? keys.indexOf(answer.choice) : -1;
	if (index === -1) {
		throw new NodeOperationError(this.getNode(), `The answer to "${name}" matches no output`, {
			itemIndex: i,
		});
	}
	return index;
}

export class Hesperan implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Hesperan',
		name: 'hesperan',
		icon: { light: 'file:hesperan.svg', dark: 'file:hesperan.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle:
			'={{ $parameter["operation"] === "reportOutcome" ? "Report outcome" : $parameter["operation"] === "ask" ? "Ask" : "Decide: " + (($parameter["profile"] && $parameter["profile"].value) || "") }}',
		description:
			'Calibrated decisions that send each item to Auto or Review, ad-hoc typed questions, and outcome feedback',
		defaults: {
			name: 'Hesperan',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: `={{(${configuredOutputs})($parameter)}}`,
		credentials: [
			{
				name: 'hesperanApi',
				required: true,
			},
		],
		properties: [
			resourceProperty,
			...operationProperties,
			...decideProperties,
			...reportOutcomeProperties,
			...askProperties,
		],
	};

	methods = {
		listSearch: { searchProfiles },
		loadOptions: { getProfileAnswers },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const outputs = configuredOutputs(this.getNode().parameters);
		const returnData: INodeExecutionData[][] = outputs.map(() => []);

		const asking = resource === 'question' && operation === 'ask';
		/** Ask with "Route by First Answer": the output names, in output order. */
		const routeKeys = asking && outputs.length > 1 ? outputs.map((o) => o.displayName ?? '') : null;
		if (
			asking &&
			!routeKeys &&
			this.getNodeParameter('routeByAnswer', 0, false) === true &&
			this.getNodeParameter('questionsMode', 0, 'fields') === 'fields'
		) {
			throw new NodeOperationError(
				this.getNode(),
				'"Route by First Answer" needs a first question of type Yes/No, or of type Choice with at least two options written as plain text (not an expression)',
			);
		}

		for (let i = 0; i < items.length; i++) {
			// where a failed item goes with "continue on fail": Review for decisions, else the first output
			let output = 0;
			try {
				if (resource === 'decision' && operation === 'decide') {
					output = 1;
					const profile = String(
						this.getNodeParameter('profile', i, '', { extractValue: true }) ?? '',
					).trim();
					if (!profile) {
						throw new NodeOperationError(this.getNode(), 'Enter the slug of a decision profile', {
							itemIndex: i,
						});
					}
					const state = readState.call(this, i, items[i], false);
					const idempotencyKey = String(this.getNodeParameter('idempotencyKey', i, '')).trim();
					if (idempotencyKey && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
						throw new NodeOperationError(
							this.getNode(),
							'The Idempotency Key must be 1–255 visible ASCII characters (no spaces)',
							{ itemIndex: i },
						);
					}
					const options = this.getNodeParameter('options', i, {}) as Options;
					const response = await hesperanRequest.call(this, {
						endpoint: 'decide',
						path: `/v1/decide/${encodeURIComponent(profile)}`,
						body: { state } as IDataObject,
						headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
						retry: options.retry !== false,
						itemIndex: i,
						profile,
					});
					const replayed = response.headers['idempotent-replayed'] === 'true';
					const body = response.body;
					const result: IDataObject = this.getNodeParameter('simplify', i, true)
						? {
								decision: body.decision,
								confidence: body.confidence,
								action: body.action,
								decision_id: body.decision_id,
								probabilities: body.probabilities,
								profile: body.profile,
								replayed,
							}
						: { ...body, replayed };
					// anything but an explicit "auto" is for a person
					output = result.action === 'auto' ? 0 : 1;
					returnData[output].push({
						json: withResult(items[i], options.outputField ?? 'hesperan', result),
						pairedItem: { item: i },
					});
				} else if (resource === 'decision' && operation === 'reportOutcome') {
					const decisionId = String(this.getNodeParameter('decisionId', i, '')).trim();
					const actual = String(this.getNodeParameter('actual', i, '')).trim();
					if (!decisionId) {
						throw new NodeOperationError(this.getNode(), 'Enter the decision ID', { itemIndex: i });
					}
					if (!actual) {
						throw new NodeOperationError(this.getNode(), 'Enter the actual answer', {
							itemIndex: i,
						});
					}
					const options = this.getNodeParameter('options', i, {}) as Options;
					const response = await hesperanRequest.call(this, {
						endpoint: 'outcomes',
						path: '/v1/outcomes',
						body: { decision_id: decisionId, actual },
						retry: options.retry !== false,
						itemIndex: i,
					});
					const result: IDataObject = {
						decision_id: decisionId,
						actual,
						ok: response.body.ok === true,
						duplicate: response.body.duplicate === true,
					};
					returnData[0].push({
						json: withResult(items[i], options.outputField ?? 'hesperanOutcome', result),
						pairedItem: { item: i },
					});
				} else if (asking) {
					const state = readState.call(this, i, items[i], true);
					const questions = readQuestions.call(this, i);
					const options = this.getNodeParameter('options', i, {}) as Options;
					const response = await hesperanRequest.call(this, {
						endpoint: 'systemone',
						path: '/v1/systemone',
						body: { state, questions } as IDataObject,
						retry: options.retry !== false,
						itemIndex: i,
					});
					if (routeKeys) {
						output = routeIndex.call(this, response.body, Object.keys(questions)[0], routeKeys, i);
					}
					returnData[output].push({
						json: withResult(items[i], options.outputField ?? 'hesperan', response.body),
						pairedItem: { item: i },
					});
				} else {
					throw new NodeOperationError(this.getNode(), `Unsupported operation "${operation}"`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				const failure =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				if (this.continueOnFail()) {
					const options = this.getNodeParameter('options', i, {}) as Options;
					const field =
						options.outputField ?? (operation === 'reportOutcome' ? 'hesperanOutcome' : 'hesperan');
					const details: IDataObject = { error: failure.message };
					if (failure instanceof NodeApiError && failure.httpCode) {
						details.status = Number(failure.httpCode);
					}
					if (failure.description) details.description = failure.description;
					// With "continue (using error output)" n8n moves items that carry `error` to its error output
					// (and restores the input fields there). With "continue" it would replace such an item's JSON by
					// the message alone, so there the item keeps its fields and the error goes into the output field:
					// a failed decision lands on Review with everything a person needs.
					const toErrorOutput = this.getNode().onError === 'continueErrorOutput';
					returnData[Math.min(output, returnData.length - 1)].push({
						json: withResult(items[i], field, details),
						...(toErrorOutput ? { error: failure } : {}),
						pairedItem: { item: i },
					});
					continue;
				}
				throw failure;
			}
		}

		// As a tool of an AI agent the node has one tool output; hand back every item there.
		if (typeof this.isToolExecution === 'function' && this.isToolExecution()) {
			return [returnData.flat()];
		}
		return returnData;
	}
}
