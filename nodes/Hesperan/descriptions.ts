import type { INodeProperties } from 'n8n-workflow';

const decide = { resource: ['decision'], operation: ['decide'] };
const reportOutcome = { resource: ['decision'], operation: ['reportOutcome'] };
const ask = { resource: ['question'], operation: ['ask'] };

export const resourceProperty: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{
			name: 'Decision',
			value: 'decision',
			description: 'Decisions with a calibrated profile, and their outcomes',
		},
		{
			name: 'Question',
			value: 'question',
			description: 'Ad-hoc typed questions without a profile',
		},
	],
	default: 'decision',
};

export const operationProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['decision'] } },
		options: [
			{
				name: 'Decide',
				value: 'decide',
				description:
					'Decide with a calibrated profile and send the item to the Auto or the Review output',
				action: 'Decide with a profile',
			},
			{
				name: 'Report Outcome',
				value: 'reportOutcome',
				description: 'Report the correct answer for an earlier decision',
				action: 'Report the outcome of a decision',
			},
		],
		default: 'decide',
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['question'] } },
		options: [
			{
				name: 'Ask',
				value: 'ask',
				description: 'Answer typed questions (choice, yes/no, score) about a state, with probabilities',
				action: 'Ask questions about a state',
			},
		],
		default: 'ask',
	},
];

const stateProperties = (show: Record<string, string[]>): INodeProperties[] => [
	{
		displayName: 'State Source',
		name: 'stateSource',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Text',
				value: 'text',
				description: 'A text, usually an expression such as the body of an email or ticket',
			},
			{
				name: 'JSON',
				value: 'json',
				description: 'A JSON object or array',
			},
			{
				name: 'Whole Input Item',
				value: 'item',
				description: 'Send the JSON of the incoming item as it is',
			},
		],
		default: 'text',
		description:
			'What the decision is about. Everything sent is read by the model and counts towards billing, so leave out fields that do not matter.',
	},
	{
		displayName: 'State',
		name: 'stateText',
		type: 'string',
		typeOptions: { rows: 4 },
		displayOptions: { show: { ...show, stateSource: ['text'] } },
		default: '',
		placeholder: 'e.g. {{ $json.subject }}\n\n{{ $json.body }}',
		description: 'The text to decide about, for example a ticket or an email',
	},
	{
		displayName: 'State (JSON)',
		name: 'stateJson',
		type: 'json',
		displayOptions: { show: { ...show, stateSource: ['json'] } },
		default: '{\n  "subject": "",\n  "body": ""\n}',
		description: 'A JSON object or array to decide about',
	},
];

/** The profile: picked from the account's profiles, or typed as a slug (also as an expression). */
const profileProperty = (show: Record<string, string[]>, required: boolean, description: string): INodeProperties => ({
	displayName: 'Profile',
	name: 'profile',
	type: 'resourceLocator',
	required,
	displayOptions: { show },
	default: { mode: 'list', value: '' },
	description,
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchProfiles', searchable: true },
		},
		{
			displayName: 'By Slug',
			name: 'slug',
			type: 'string',
			placeholder: 'e.g. ticket-routing',
			validation: [
				{
					type: 'regex',
					properties: { regex: '^[^\\s/]+$', errorMessage: 'A profile slug has no spaces or slashes' },
				},
			],
		},
	],
});

export const decideProperties: INodeProperties[] = [
	profileProperty(
		decide,
		true,
		'A calibrated decision profile from the Hesperan console (Profiles)',
	),
	...stateProperties(decide),
	{
		displayName: 'Idempotency Key',
		name: 'idempotencyKey',
		type: 'string',
		displayOptions: { show: decide },
		default: '',
		placeholder: 'e.g. ticket-{{ $json.number }}',
		description:
			'Optional. The same key with the same state within 24 hours returns the first decision again and is not charged twice. Up to 255 visible ASCII characters, for example a ticket or message ID.',
	},
	{
		displayName: 'Items that get a decision go to <b>Auto</b> when its calibrated confidence reaches the profile\'s threshold, and to <b>Review</b> otherwise, for a person to decide',
		name: 'decideNotice',
		type: 'notice',
		displayOptions: { show: decide },
		default: '',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		displayOptions: { show: decide },
		default: {},
		options: [
			{
				displayName: 'Put Output in Field',
				name: 'outputField',
				type: 'string',
				default: 'hesperan',
				description:
					'The field of the item that receives the decision. Leave empty to merge the fields into the item.',
			},
			{
				displayName: 'Retry Temporary Errors',
				name: 'retry',
				type: 'boolean',
				default: true,
				description:
					'Whether to retry up to 3 times after a rate limit (429), a model error (502) or a starting model (503 with Retry-After). These failures are never charged.',
			},
		],
	},
];

export const reportOutcomeProperties: INodeProperties[] = [
	{
		displayName: 'Decision ID',
		name: 'decisionId',
		type: 'string',
		required: true,
		displayOptions: { show: reportOutcome },
		default: '',
		placeholder: 'e.g. {{ $json.hesperan.decision_id }}',
		description: 'The decision_id returned by "Decide"',
	},
	profileProperty(
		reportOutcome,
		false,
		'Optional: the profile of the decision, only used to list its answers below. It is not sent.',
	),
	{
		displayName: 'Actual Answer Name or ID',
		name: 'actual',
		type: 'options',
		required: true,
		typeOptions: { loadOptionsMethod: 'getProfileAnswers', loadOptionsDependsOn: ['profile.value'] },
		displayOptions: { show: reportOutcome },
		default: '',
		description:
			'The answer that was right, for example the team that finally handled the ticket. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		displayOptions: { show: reportOutcome },
		default: {},
		options: [
			{
				displayName: 'Put Output in Field',
				name: 'outputField',
				type: 'string',
				default: 'hesperanOutcome',
				description:
					'The field of the item that receives the result. Leave empty to merge the fields into the item.',
			},
			{
				displayName: 'Retry Temporary Errors',
				name: 'retry',
				type: 'boolean',
				default: true,
				description: 'Whether to retry up to 3 times after a rate limit (429)',
			},
		],
	},
];

export const askProperties: INodeProperties[] = [
	...stateProperties(ask),
	{
		displayName: 'Questions Input',
		name: 'questionsMode',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: ask },
		options: [
			{ name: 'Define Below', value: 'fields' },
			{
				name: 'JSON',
				value: 'json',
				description: 'The questions object of POST /v1/systemone',
			},
		],
		default: 'fields',
	},
	{
		displayName: 'Questions',
		name: 'questions',
		type: 'fixedCollection',
		placeholder: 'Add Question',
		typeOptions: { multipleValues: true, sortable: true },
		displayOptions: { show: { ...ask, questionsMode: ['fields'] } },
		default: {},
		options: [
			{
				displayName: 'Question',
				name: 'question',
				values: [
					{
						displayName: 'Answer Name',
						name: 'name',
						type: 'string',
						default: '',
						placeholder: 'e.g. team',
						description: 'The key of this answer in the output',
					},
					{
						displayName: 'Answer Type',
						name: 'type',
						type: 'options',
						options: [
							{
								name: 'Choice',
								value: 'choice',
								description: 'Pick one of several options',
							},
							{
								name: 'Yes/No',
								value: 'noul',
								description: 'The probability that a statement holds',
							},
							{
								name: 'Score',
								value: 'score',
								description: 'A level on a scale you describe',
							},
						],
						default: 'choice',
					},
					{
						displayName: 'Instructions',
						name: 'instructions',
						type: 'string',
						default: '',
						placeholder: 'e.g. Which team should handle this ticket?',
						description: 'The question (choice, score), or the statement to check (yes/no)',
					},
					{
						displayName: 'Levels',
						name: 'levels',
						type: 'string',
						default: '',
						placeholder: 'not urgent\nsomewhat urgent\nurgent',
						description: 'One level per line, lowest first',
					},
					{
						displayName: 'No Means',
						name: 'noMeans',
						type: 'string',
						default: '',
						description: 'Optional:\twhat \'no\' means in this case',
					},
					{
						displayName: 'Options',
						name: 'options',
						type: 'string',
						default: '',
						placeholder: 'billing:\tpayments, invoices, refunds\nshipping:\tdelivery and returns\ntechnical',
						description: 'One option per line:\ta key, optionally followed by a colon and a description',
					},
					{
						displayName: 'Yes Means',
						name: 'yesMeans',
						type: 'string',
						default: '',
						description: 'Optional:\twhat \'yes\' means in this case',
					},
			],
			},
		],
	},
	{
		displayName: 'Questions (JSON)',
		name: 'questionsJson',
		type: 'json',
		displayOptions: { show: { ...ask, questionsMode: ['json'] } },
		default:
			'{\n  "team": {\n    "type": "choice",\n    "instructions": "Which team should handle this ticket?",\n    "criteria": { "billing": "payments and refunds", "shipping": "delivery", "technical": "" }\n  }\n}',
		description:
			'Map of question name to { type: "choice" | "noul" | "score", instructions, criteria }, as in POST /v1/systemone',
	},
	{
		displayName: 'Route by First Answer',
		name: 'routeByAnswer',
		type: 'boolean',
		displayOptions: { show: { ...ask, questionsMode: ['fields'] } },
		default: false,
		description:
			'Whether to give the node one output per option of the first question (choice), or a Yes and a No output (yes/no: Yes when the probability is at least 0.5). The options must be plain text, not an expression.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		displayOptions: { show: ask },
		default: {},
		options: [
			{
				displayName: 'Put Output in Field',
				name: 'outputField',
				type: 'string',
				default: 'hesperan',
				description:
					'The field of the item that receives the answers. Leave empty to merge the fields into the item.',
			},
			{
				displayName: 'Retry Temporary Errors',
				name: 'retry',
				type: 'boolean',
				default: true,
				description:
					'Whether to retry up to 3 times after a rate limit (429), a model error (502) or a starting model (503 with Retry-After). These failures are never charged.',
			},
		],
	},
];
