import type { IDataObject } from 'n8n-workflow';

/** One question as the Hesperan API expects it (`POST /v1/systemone`). */
export type ApiQuestion =
	| { type: 'choice'; instructions: string; criteria: Record<string, string> }
	| { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
	| { type: 'score'; instructions: string; criteria: string[] };

/** A question as entered in the node's "Questions" list. */
export interface QuestionFields {
	name?: string;
	type?: 'choice' | 'noul' | 'score';
	instructions?: string;
	options?: string;
	yesMeans?: string;
	noMeans?: string;
	levels?: string;
}

/** The server accepts at most this many options per question. */
export const MAX_OPTIONS = 255;

export class QuestionError extends Error {}

const lines = (text: string | undefined) =>
	String(text ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

/**
 * Parse choice options, one per line: `key` or `key: description`.
 * An empty description falls back to the key on the server.
 */
export function parseOptions(text: string | undefined): Record<string, string> {
	const criteria: Record<string, string> = {};
	for (const line of lines(text)) {
		const colon = line.indexOf(':');
		const key = (colon === -1 ? line : line.slice(0, colon)).trim();
		const description = colon === -1 ? '' : line.slice(colon + 1).trim();
		if (!key) continue;
		if (key in criteria) throw new QuestionError(`option "${key}" is listed twice`);
		criteria[key] = description;
	}
	return criteria;
}

/** Turn the node's question list into the API's `questions` object. */
export function buildQuestions(list: QuestionFields[]): Record<string, ApiQuestion> {
	if (!list.length) throw new QuestionError('add at least one question');
	const questions: Record<string, ApiQuestion> = {};
	for (const [index, q] of list.entries()) {
		const name = String(q.name ?? '').trim();
		const label = name ? `question "${name}"` : `question ${index + 1}`;
		if (!name) throw new QuestionError(`${label} needs a name`);
		if (name in questions) throw new QuestionError(`two questions are named "${name}"`);
		const instructions = String(q.instructions ?? '').trim();
		if (!instructions) throw new QuestionError(`${label} needs instructions`);
		const type = q.type ?? 'choice';

		if (type === 'choice') {
			const criteria = parseOptions(q.options);
			const count = Object.keys(criteria).length;
			if (count < 2) throw new QuestionError(`${label} needs at least two options, one per line`);
			if (count > MAX_OPTIONS)
				throw new QuestionError(`${label} has more than ${MAX_OPTIONS} options`);
			questions[name] = { type, instructions, criteria };
		} else if (type === 'noul') {
			const criteria: { true?: string; false?: string } = {};
			if (q.yesMeans?.trim()) criteria.true = q.yesMeans.trim();
			if (q.noMeans?.trim()) criteria.false = q.noMeans.trim();
			questions[name] = Object.keys(criteria).length
				? { type, instructions, criteria }
				: { type, instructions };
		} else if (type === 'score') {
			const criteria = lines(q.levels);
			if (criteria.length < 2)
				throw new QuestionError(`${label} needs at least two levels, lowest first, one per line`);
			if (criteria.length > MAX_OPTIONS)
				throw new QuestionError(`${label} has more than ${MAX_OPTIONS} levels`);
			questions[name] = { type, instructions, criteria };
		} else {
			throw new QuestionError(`${label} has an unknown type "${String(type)}"`);
		}
	}
	return questions;
}

/** JSON.parse that returns undefined instead of throwing. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/** Check a `questions` object given as JSON (advanced mode) before sending it. */
export function validateQuestionsJson(value: unknown): IDataObject {
	let parsed = value;
	if (typeof value === 'string') {
		parsed = parseJson(value);
		if (parsed === undefined) throw new QuestionError('Questions (JSON) is not valid JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new QuestionError(
			'Questions (JSON) must be an object: question name → { type, instructions, criteria }',
		);
	}
	const entries = Object.entries(parsed as IDataObject);
	if (!entries.length) throw new QuestionError('add at least one question');
	for (const [name, q] of entries) {
		const type = (q as IDataObject | null)?.type;
		if (type !== 'choice' && type !== 'noul' && type !== 'score') {
			throw new QuestionError(`question "${name}" needs "type": "choice", "noul" or "score"`);
		}
	}
	return parsed as IDataObject;
}
