import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

export const DEFAULT_BASE_URL = 'https://api.hesperan.com';
export const CREDENTIAL_NAME = 'hesperanApi';

/** Retries after 429, 502 and a 503 that carries Retry-After. Never after a 503 "opens soon". */
export const MAX_RETRIES = 3;
/** Longest single wait we accept from Retry-After; longer waits are left to the workflow. */
export const MAX_RETRY_WAIT_MS = 60_000;

export type Endpoint = 'decide' | 'systemone' | 'outcomes' | 'profiles';

export interface HesperanRequest {
	endpoint: Endpoint;
	method?: 'GET' | 'POST';
	path: string;
	body?: IDataObject;
	headers?: Record<string, string>;
	/** retry transient failures (429, 502, 503 with Retry-After) */
	retry: boolean;
	itemIndex: number;
	/** the profile slug, for error messages */
	profile?: string;
}

export interface HesperanResponse {
	body: IDataObject;
	headers: Record<string, string>;
}

interface FullResponse {
	statusCode: number;
	headers?: Record<string, unknown>;
	body?: unknown;
}

const header = (headers: Record<string, unknown> | undefined, name: string): string | undefined => {
	if (!headers) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return Array.isArray(value) ? String(value[0]) : String(value);
	}
	return undefined;
};

const asObject = (body: unknown): IDataObject => {
	if (body && typeof body === 'object' && !Array.isArray(body)) return body as IDataObject;
	if (typeof body === 'string') {
		try {
			const parsed: unknown = JSON.parse(body);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
				return parsed as IDataObject;
		} catch {
			// not JSON; handled below
		}
		return { error: body.slice(0, 500) };
	}
	return {};
};

const retryAfterSeconds = (headers: Record<string, unknown> | undefined): number | undefined => {
	const value = header(headers, 'retry-after');
	if (value === undefined) return undefined;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

/** 429, 502 and a 503 with Retry-After are transient. A 503 without Retry-After means "opens soon". */
export function isRetryable(status: number, retryAfter: number | undefined): boolean {
	if (status === 429 || status === 502) return true;
	return status === 503 && retryAfter !== undefined;
}

/** Wait before the next attempt: Retry-After if given, else 1 s, 2 s, 4 s … with jitter. */
export function retryDelayMs(attempt: number, retryAfter: number | undefined): number {
	const base = retryAfter !== undefined ? retryAfter * 1000 : 1000 * 2 ** attempt;
	return Math.min(MAX_RETRY_WAIT_MS, base + Math.floor(Math.random() * 250));
}

/** Map a Hesperan error response to an error with a message that says what happened and what to do. */
export function hesperanError(
	node: INode,
	status: number,
	body: IDataObject,
	headers: Record<string, unknown> | undefined,
	request: Pick<HesperanRequest, 'endpoint' | 'itemIndex' | 'profile'>,
): NodeApiError {
	const apiMessage = typeof body.error === 'string' && body.error ? body.error : `HTTP ${status}`;
	const retryAfter = retryAfterSeconds(headers);
	let message: string;
	let description: string;

	switch (status) {
		case 400:
			message = `Hesperan rejected the request: ${apiMessage}`;
			description =
				'Fix the request; sending it again unchanged will fail the same way. Nothing was charged.';
			break;
		case 401:
			message = 'Hesperan rejected the API key';
			description =
				'Check the API key in the Hesperan credential. It may be incomplete or revoked in the Hesperan console.';
			break;
		case 402:
			message = `Hesperan: ${apiMessage}`;
			description =
				'Nothing was charged. Top up your balance or subscribe to Pro in the Hesperan console (Billing), then run again.';
			break;
		case 404:
			if (request.endpoint === 'decide') {
				message = `Unknown decision profile "${request.profile ?? ''}"`;
				description = 'Check the profile slug in the Hesperan console. Nothing was charged.';
			} else if (request.endpoint === 'outcomes') {
				message = 'Unknown decision ID';
				description =
					'Report outcomes with the decision_id returned by "Decide", using an API key of the same account.';
			} else {
				message = `Hesperan: ${apiMessage}`;
				description =
					'Check the base URL in the Hesperan credential (default https://api.hesperan.com).';
			}
			break;
		case 409:
			message = `Hesperan: ${apiMessage}`;
			description =
				request.endpoint === 'outcomes'
					? 'Each decision takes one outcome. Reporting the same answer again is fine; a different answer is refused.'
					: 'Either the profile has no calibration yet, or this Idempotency-Key was already used with a different state. Nothing was charged.';
			break;
		case 413:
			message = 'The request is too large for Hesperan';
			description = 'A request body may be at most 256 KB. Send less state. Nothing was charged.';
			break;
		case 429:
			message = 'Hesperan rate limit reached';
			description = `Limits apply per API key and minute.${retryAfter !== undefined ? ` Retry after ${retryAfter} s.` : ''} Nothing was charged.`;
			break;
		case 502:
			message = 'The Hesperan model could not answer';
			description = `${apiMessage}. Nothing was charged. Retry later.`;
			break;
		case 503:
			if (retryAfter !== undefined) {
				message = 'The Hesperan model is starting';
				description = `Retry after ${retryAfter} s. Nothing was charged.`;
			} else {
				message = 'The Hesperan API is not open yet: no model is connected';
				description =
					'Nothing was charged. Retrying will not help until Hesperan opens; GET /health shows model_status.';
			}
			break;
		default:
			message = `Hesperan answered HTTP ${status}: ${apiMessage}`;
			description = 'Nothing was charged unless the request succeeded.';
	}

	return new NodeApiError(node, { ...body, status } as JsonObject, {
		message,
		description,
		httpCode: String(status),
		itemIndex: request.itemIndex,
	});
}

/**
 * Call the Hesperan API with the node's credential. Returns the JSON body of a 2xx answer, throws a
 * NodeApiError otherwise. Transient failures are retried a few times when `retry` is set; every retried
 * failure was free, so a retry never charges twice.
 */
export async function hesperanRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	request: HesperanRequest,
): Promise<HesperanResponse> {
	const credentials = await this.getCredentials<{ baseUrl?: string }>(CREDENTIAL_NAME);
	const baseUrl = String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
	const method = request.method ?? 'POST';
	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${request.path}`,
		headers: { Accept: 'application/json', ...request.headers },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (method === 'POST') options.body = request.body ?? {};

	for (let attempt = 0; ; attempt++) {
		let response: FullResponse;
		try {
			response = (await this.helpers.httpRequestWithAuthentication.call(
				this,
				CREDENTIAL_NAME,
				options,
			)) as FullResponse;
		} catch (error) {
			throw new NodeApiError(this.getNode(), error as JsonObject, {
				message: 'Could not reach the Hesperan API',
				description: `Check the base URL in the Hesperan credential (${baseUrl}) and the network.`,
				itemIndex: request.itemIndex,
			});
		}

		const status = Number(response.statusCode);
		const body = asObject(response.body);
		if (status >= 200 && status < 300) {
			const headers: Record<string, string> = {};
			for (const [key, value] of Object.entries(response.headers ?? {}))
				headers[key.toLowerCase()] = String(value);
			return { body, headers };
		}

		const retryAfter = retryAfterSeconds(response.headers);
		if (request.retry && attempt < MAX_RETRIES && isRetryable(status, retryAfter)) {
			const wait = retryDelayMs(attempt, retryAfter);
			if (retryAfter === undefined || retryAfter * 1000 <= MAX_RETRY_WAIT_MS) {
				await sleep(wait);
				continue;
			}
		}
		throw hesperanError(this.getNode(), status, body, response.headers, request);
	}
}
