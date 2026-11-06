import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INode,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { API_PREFIX, MAX_PAGES, REQUEST_TIMEOUT_MS, normalizeBaseUrl, redact } from './security';

export const CREDENTIAL_NAME = 'geoPulseApi';

export type GeoPulseContext = IExecuteFunctions | IPollFunctions;

export interface GeoPulseRequest {
	method: IHttpRequestMethods;
	/** Absolute path starting with /api/. */
	path: string;
	qs?: IDataObject;
	body?: IDataObject | IDataObject[];
	/** Download the body as a Buffer instead of parsing JSON. */
	binary?: boolean;
	/** Extra values to remove from error messages, e.g. a share link password. */
	secrets?: string[];
}

export interface GeoPulseResponse {
	statusCode: number;
	headers: Record<string, string>;
	body: unknown;
}

interface Session {
	baseUrl: string;
	secrets: string[];
}

async function getSession(ctx: GeoPulseContext): Promise<Session> {
	const credentials = await ctx.getCredentials(CREDENTIAL_NAME);
	const secrets = [credentials.apiToken, credentials.gpsSourceToken].filter(
		(value): value is string => typeof value === 'string' && value !== '',
	);
	try {
		return { baseUrl: normalizeBaseUrl(credentials.baseUrl), secrets };
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Invalid Base URL in the GeoPulse credential: ${redact((error as Error).message, secrets)}`,
		);
	}
}

/** Returns the Base URL of the credential, validated and without trailing slashes. */
export async function getBaseUrl(ctx: GeoPulseContext): Promise<string> {
	return (await getSession(ctx)).baseUrl;
}

/** Returns the secrets of the credential, used to redact error messages. */
export async function getCredentialSecrets(ctx: GeoPulseContext): Promise<string[]> {
	const credentials = await ctx.getCredentials(CREDENTIAL_NAME);
	return [credentials.apiToken, credentials.gpsSourceToken].filter(
		(value): value is string => typeof value === 'string' && value !== '',
	);
}

function lowerCaseHeaders(headers: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (headers && typeof headers === 'object') {
		for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
			out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
		}
	}
	return out;
}

function parseBody(body: unknown): unknown {
	if (body === undefined || body === null || body === '') return undefined;
	if (typeof body === 'string') {
		try {
			return JSON.parse(body);
		} catch {
			return body;
		}
	}
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
		const text = Buffer.from(body as ArrayBuffer).toString('utf8');
		return parseBody(text);
	}
	return body;
}

function describeNetworkError(error: unknown): string {
	const err = (error ?? {}) as { code?: unknown; message?: unknown };
	const code = typeof err.code === 'string' ? err.code : '';
	if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(String(err.message))) {
		return `GeoPulse did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`;
	}
	if (code === 'ECONNREFUSED')
		return 'Connection to GeoPulse refused: check the Base URL and that the server is running';
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
		return 'GeoPulse host not found: check the Base URL';
	if (/certificate|self[- ]signed|SSL|TLS/i.test(String(err.message))) {
		return `TLS error while connecting to GeoPulse: ${String(err.message)}`;
	}
	const message =
		typeof err.message === 'string' && err.message !== '' ? err.message : 'unknown error';
	return `Request to GeoPulse failed${code ? ` (${code})` : ''}: ${message}`;
}

/** Builds the error for a non-2xx GeoPulse response from its RFC 9457 problem body. */
export function apiError(
	node: INode,
	statusCode: number,
	body: unknown,
	headers: Record<string, string>,
	secrets: string[],
): NodeOperationError {
	const problem = (
		body && typeof body === 'object' && !Array.isArray(body) ? body : {}
	) as IDataObject;
	const parameters = (problem.parameters ?? {}) as IDataObject;
	const code = typeof problem.code === 'string' ? problem.code : undefined;
	const rawDetail =
		problem.detail ??
		problem.message ??
		problem.title ??
		(typeof body === 'string' ? body : undefined);
	const detail =
		typeof rawDetail === 'string' && rawDetail.trim() !== ''
			? rawDetail.trim().slice(0, 500)
			: undefined;

	let message: string;
	if (statusCode === 401) {
		message =
			'GeoPulse rejected the API token (401): check that it is correct and not expired or revoked';
	} else if (statusCode === 403 && code === 'API_TOKEN_SCOPE_REQUIRED') {
		const scope =
			problem.requiredScope ?? parameters.requiredScope ?? headers['x-geopulse-required-scope'];
		message = scope
			? `The API token is missing the '${String(scope)}' scope required for this operation. Create a token with the '${String(scope)}' scope in GeoPulse (Menu → Profile → Security → API tokens)`
			: 'The API token does not have the scope required for this operation';
	} else if (statusCode === 403) {
		message = `GeoPulse denied access (403${code ? ` ${code}` : ''})${detail ? `: ${detail}` : ''}`;
	} else if (statusCode === 404) {
		message = `Not found (404${code ? ` ${code}` : ''})${detail ? `: ${detail}` : ''}`;
	} else {
		message = `GeoPulse error ${statusCode}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`;
	}

	const ids = [
		typeof problem.errorId === 'string' ? `errorId ${problem.errorId}` : undefined,
		typeof problem.requestId === 'string' ? `requestId ${problem.requestId}` : undefined,
	].filter(Boolean);
	return new NodeOperationError(node, redact(message, secrets), {
		description: ids.length ? redact(ids.join(', '), secrets) : undefined,
	});
}

/**
 * Sends one request to GeoPulse. The token is added by the credential (Authorization: Bearer),
 * redirects are never followed, every request has a 30 s timeout, and errors never contain the
 * token or query strings.
 */
export async function geoPulseRequest(
	ctx: GeoPulseContext,
	request: GeoPulseRequest,
): Promise<GeoPulseResponse> {
	const { baseUrl, secrets: credentialSecrets } = await getSession(ctx);
	const secrets = [...credentialSecrets, ...(request.secrets ?? [])];
	const node = ctx.getNode();
	if (!request.path.startsWith(API_PREFIX)) {
		throw new NodeOperationError(node, 'Internal error: request path must start with /api/');
	}

	const options: IHttpRequestOptions = {
		method: request.method,
		url: `${baseUrl}${request.path}`,
		headers: { Accept: request.binary ? '*/*' : 'application/json' },
		timeout: REQUEST_TIMEOUT_MS,
		disableFollowRedirect: true,
		maxRedirects: 0,
		sendCredentialsOnCrossOriginRedirect: false,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		json: !request.binary,
	};
	if (request.binary) options.encoding = 'arraybuffer';
	if (request.qs) {
		const qs: IDataObject = {};
		for (const [key, value] of Object.entries(request.qs)) {
			if (value !== undefined && value !== null && value !== '') qs[key] = value;
		}
		if (Object.keys(qs).length) options.qs = qs;
	}
	if (request.body !== undefined) {
		options.body = request.body;
		(options.headers as IDataObject)['Content-Type'] = 'application/json';
	}

	let raw: { statusCode?: number; status?: number; headers?: unknown; body?: unknown };
	try {
		raw = await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_NAME, options);
	} catch (error) {
		throw new NodeOperationError(node, redact(describeNetworkError(error), secrets));
	}

	const statusCode = Number(raw?.statusCode ?? raw?.status ?? 0);
	const headers = lowerCaseHeaders(raw?.headers);

	if (statusCode >= 300 && statusCode < 400) {
		let target = '';
		try {
			const location = new URL(headers.location ?? '', `${baseUrl}/`);
			target = ` to ${location.protocol}//${location.host}`;
		} catch {
			target = '';
		}
		throw new NodeOperationError(
			node,
			`GeoPulse answered with a redirect (HTTP ${statusCode}${target}). Redirects are not followed: set the final address as Base URL in the credential`,
		);
	}

	if (request.binary && statusCode >= 200 && statusCode < 300) {
		const body = raw?.body;
		let buffer: Buffer;
		if (Buffer.isBuffer(body)) buffer = body;
		else if (body instanceof ArrayBuffer) buffer = Buffer.from(body);
		else if (ArrayBuffer.isView(body))
			buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
		else if (typeof body === 'string') buffer = Buffer.from(body, 'utf8');
		else buffer = Buffer.alloc(0);
		return { statusCode, headers, body: buffer };
	}

	const body = parseBody(raw?.body);
	if (statusCode < 200 || statusCode >= 300) {
		throw apiError(node, statusCode || 500, body, headers, secrets);
	}
	const contentType = headers['content-type'] ?? '';
	if (typeof body === 'string' && /text\/html/i.test(contentType)) {
		throw new NodeOperationError(
			node,
			'GeoPulse returned an HTML page instead of JSON: check that the Base URL points to the GeoPulse server, without /api',
		);
	}
	return { statusCode, headers, body };
}

/** Sends a request and returns the parsed JSON body. */
export async function geoPulseApiRequest(
	ctx: GeoPulseContext,
	method: IHttpRequestMethods,
	path: string,
	qs?: IDataObject,
	body?: IDataObject | IDataObject[],
	secrets?: string[],
): Promise<unknown> {
	const response = await geoPulseRequest(ctx, { method, path, qs, body, secrets });
	return response.body;
}

/**
 * Reads a page-based list (`page` from 1, `size`) such as GET /api/v1/gps/points. Stops at the
 * last page, at `limit` items, when a page repeats, or after MAX_PAGES pages.
 */
export async function geoPulsePaginate(
	ctx: GeoPulseContext,
	path: string,
	qs: IDataObject,
	options: { returnAll: boolean; limit: number; maxPageSize: number },
): Promise<IDataObject[]> {
	const node = ctx.getNode();
	const pageSize = options.returnAll
		? options.maxPageSize
		: Math.max(1, Math.min(options.maxPageSize, options.limit));
	const results: IDataObject[] = [];
	let previousSignature: string | undefined;

	for (let page = 1; page <= MAX_PAGES; page++) {
		const body = (await geoPulseApiRequest(ctx, 'GET', path, {
			...qs,
			page,
			size: pageSize,
		})) as IDataObject;
		const items = Array.isArray(body?.items) ? (body.items as IDataObject[]) : [];
		if (items.length === 0) return results;

		const signature = JSON.stringify([
			items[0]?.id ?? items[0],
			items[items.length - 1]?.id,
			items.length,
		]);
		if (signature === previousSignature) {
			throw new NodeOperationError(
				node,
				'GeoPulse returned the same page twice: the server does not seem to support pagination for this request',
			);
		}
		previousSignature = signature;

		results.push(...items);
		if (!options.returnAll && results.length >= options.limit)
			return results.slice(0, options.limit);

		const totalPages = Number(body?.totalPages);
		if (Number.isFinite(totalPages) && page >= totalPages) return results;
		if (items.length < pageSize) return results;
	}
	throw new NodeOperationError(
		node,
		`Stopped after ${MAX_PAGES} pages (${results.length} items): narrow the time range or use a limit`,
	);
}
