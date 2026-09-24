/**
 * Output layout of the node, computed from its parameters.
 *
 * This function is also embedded as source text into the node description (`outputs: '={{(fn)($parameter)}}'`,
 * the same technique n8n's own Switch node uses), so it runs inside n8n's expression sandbox. It must stay
 * self-contained: no imports, no helpers from outside its body, no syntax that TypeScript would down-level
 * into shared helpers (no optional chaining, no nullish coalescing, no object spread).
 *
 * - Decision → Decide: two outputs, "Auto" and "Review".
 * - Question → Ask with "Route by First Answer": one output per option of the first question
 *   (choice: its option keys; yes/no: "Yes" and "No"), as long as those options are plain text.
 * - Everything else: one output.
 */
export type OutputDefinition = { type: 'main'; displayName?: string };

export const configuredOutputs = (parameters: Record<string, unknown>): OutputDefinition[] => {
	const resource = parameters.resource === undefined ? 'decision' : parameters.resource;
	const operation = parameters.operation === undefined ? 'decide' : parameters.operation;
	const single: OutputDefinition[] = [{ type: 'main' }];

	if (resource === 'decision' && operation === 'decide') {
		return [
			{ type: 'main', displayName: 'Auto' },
			{ type: 'main', displayName: 'Review' },
		];
	}
	if (resource !== 'question' || operation !== 'ask' || parameters.routeByAnswer !== true)
		return single;
	if (parameters.questionsMode === 'json') return single;

	const collection = parameters.questions as
		| { question?: Array<Record<string, unknown>> }
		| undefined;
	const list = collection && Array.isArray(collection.question) ? collection.question : [];
	if (list.length === 0) return single;
	const first = list[0];
	const type = first.type === undefined ? 'choice' : first.type;

	if (type === 'noul') {
		return [
			{ type: 'main', displayName: 'Yes' },
			{ type: 'main', displayName: 'No' },
		];
	}
	if (type !== 'choice' || typeof first.options !== 'string' || first.options.charAt(0) === '=')
		return single;

	const keys: string[] = [];
	const lines = first.options.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		const colon = line.indexOf(':');
		const key = (colon === -1 ? line : line.slice(0, colon)).trim();
		if (key && keys.indexOf(key) === -1) keys.push(key);
	}
	if (keys.length < 2) return single;
	return keys.map((key) => ({ type: 'main' as const, displayName: key }));
};
