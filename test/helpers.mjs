// Test helpers: a fake GeoPulse HTTP server and minimal n8n execution contexts.
// Plain JavaScript on purpose: it uses node:http, which the n8n Cloud lint rules forbid in
// TypeScript sources. It is never published (package.json "files" ships only dist/ and index.js).
import http from 'node:http';

import { GeoPulseApi } from '../credentials/GeoPulseApi.credentials';

/** Dummy values used only by the tests. */
export const TOKEN = ['gp', 'test', 'token', '7f3a9c1e5b'].join('_');
export const GPS_TOKEN = ['gps', 'source', 'token', '42abcdef'].join('_');
export const WRONG_TOKEN = ['wrong', 'token', '123'].join('-');
export const SHARE_PASSWORD = ['s3cret', 'pass'].join('-');

/**
 * Fake GeoPulse server: rejects requests whose token is in the query string or whose
 * Authorization header is not `Bearer <TOKEN>` (or the GPS source token on the ingest path).
 */
export async function startServer(handler = () => ({ status: 404 }), options = {}) {
	let current = handler;
	const requests = [];
	const violations = [];
	const checkAuth = options.checkAuth ?? true;

	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', async () => {
			const url = new URL(req.url ?? '/', 'http://localhost');
			const text = Buffer.concat(chunks).toString('utf8');
			let body;
			if (text) {
				try {
					body = JSON.parse(text);
				} catch {
					body = text;
				}
			}
			const recorded = {
				method: req.method ?? 'GET',
				path: url.pathname,
				query: url.searchParams,
				headers: req.headers,
				body,
			};
			requests.push(recorded);

			const send = (reply) => {
				const headers = { ...(reply.headers ?? {}) };
				let payload = '';
				if (reply.json !== undefined) {
					payload = JSON.stringify(reply.json);
					headers['content-type'] ??= 'application/json';
				} else if (reply.body !== undefined) {
					payload = reply.body;
				}
				res.writeHead(reply.status ?? 200, headers);
				res.end(payload);
			};

			const rawQuery = url.search.toLowerCase();
			if (
				rawQuery.includes(TOKEN.toLowerCase()) ||
				rawQuery.includes(GPS_TOKEN.toLowerCase()) ||
				/[?&](api_key|apikey|token|access_token)=/.test(rawQuery)
			) {
				violations.push(`token in query: ${req.method} ${url.pathname}`);
				return send({ status: 400, json: { code: 'BAD_REQUEST', detail: 'token in query' } });
			}
			if (checkAuth) {
				const auth = req.headers.authorization;
				const ingest = url.pathname.endsWith('/api/v1/gps/ingest/home-assistant/batch');
				const ok = auth === `Bearer ${TOKEN}` || (ingest && auth === `Bearer ${GPS_TOKEN}`);
				if (!ok) {
					return send({
						status: 401,
						headers: { 'content-type': 'application/problem+json' },
						json: {
							type: 'urn:geopulse:error:AUTHENTICATION_REQUIRED',
							title: 'Unauthorized',
							status: 401,
							detail: 'Authentication required',
							code: 'AUTHENTICATION_REQUIRED',
							errorId: 'err-1',
							requestId: 'req-1',
						},
					});
				}
			}
			try {
				send(await current(recorded));
			} catch (error) {
				send({ status: 500, json: { detail: String(error) } });
			}
		});
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		violations,
		setHandler(next) {
			current = next;
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

export function problem(status, code, detail, extra = {}) {
	return {
		status,
		headers: { 'content-type': 'application/problem+json' },
		json: {
			type: `urn:geopulse:error:${code}`,
			status,
			code,
			detail,
			errorId: 'e-1',
			requestId: 'r-1',
			...extra,
		},
	};
}

/**
 * Minimal stand-in for n8n's `helpers.httpRequest`, implementing the options used by the nodes.
 * Like axios, an HTTP error (without ignoreHttpStatusErrors) carries the request headers, so the
 * tests can check that the nodes never leak them.
 */
export async function fakeHttpRequest(options) {
	const url = new URL(options.url, options.baseURL);
	for (const [key, value] of Object.entries(options.qs ?? {})) {
		if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
	}
	const headers = {};
	for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = String(value);
	let body;
	if (options.body !== undefined) {
		body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
		headers['Content-Type'] ??= 'application/json';
	}
	const response = await fetch(url, {
		method: options.method ?? 'GET',
		headers,
		body,
		redirect: options.disableFollowRedirect ? 'manual' : 'follow',
		signal: AbortSignal.timeout(options.timeout ?? 30_000),
	});
	const buffer = Buffer.from(await response.arrayBuffer());
	let parsed;
	if (options.encoding === 'arraybuffer') {
		parsed = buffer;
	} else {
		const text = buffer.toString('utf8');
		try {
			parsed = text === '' ? '' : JSON.parse(text);
		} catch {
			parsed = text;
		}
	}
	const responseHeaders = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});
	if (!options.ignoreHttpStatusErrors && response.status >= 400) {
		const error = new Error(
			`Request failed with status code ${response.status} ${JSON.stringify({ url: url.toString(), headers })}`,
		);
		throw Object.assign(error, { config: { headers } });
	}
	if (options.returnFullResponse) {
		return { statusCode: response.status, headers: responseHeaders, body: parsed };
	}
	return parsed;
}

export function credentials(baseUrl, extra = {}) {
	return { baseUrl, apiToken: TOKEN, gpsSourceToken: '', ...extra };
}

const credentialType = new GeoPulseApi();

async function httpRequestWithAuthentication(creds, options) {
	const authenticated = await credentialType.authenticate(creds, options);
	return await fakeHttpRequest(authenticated);
}

const NODE = {
	id: 'node-1',
	name: 'GeoPulse',
	type: 'n8n-nodes-geopulse.geoPulse',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export function executeContext(options) {
	const items = options.items ?? [{ json: {} }];
	const binaries = [];
	const ctx = {
		getInputData: () => items,
		getNode: () => NODE,
		getTimezone: () => options.timezone ?? 'UTC',
		continueOnFail: () => options.continueOnFail ?? false,
		getCredentials: async () => options.credentials,
		getNodeParameter: (name, itemIndex, fallback) => {
			const value = options.params[name];
			if (value === undefined) {
				if (fallback !== undefined) return fallback;
				throw new Error(`Missing parameter ${name}`);
			}
			return typeof value === 'function' ? value(itemIndex) : value;
		},
		helpers: {
			httpRequestWithAuthentication: async (_type, requestOptions) =>
				await httpRequestWithAuthentication(options.credentials, requestOptions),
			prepareBinaryData: async (buffer, fileName, mimeType) => {
				binaries.push({ fileName, mimeType, size: buffer.length });
				return {
					data: buffer.toString('base64'),
					fileName,
					mimeType: mimeType ?? 'application/octet-stream',
					fileSize: String(buffer.length),
				};
			},
		},
	};
	return { ctx, binaries };
}

export function pollContext(options) {
	const staticData = options.staticData ?? {};
	const ctx = {
		getNode: () => ({
			...NODE,
			name: 'GeoPulse Trigger',
			type: 'n8n-nodes-geopulse.geoPulseTrigger',
		}),
		getMode: () => options.mode ?? 'trigger',
		getWorkflowStaticData: () => staticData,
		getCredentials: async () => options.credentials,
		getNodeParameter: (name, fallback) => {
			const value = options.params[name];
			return value === undefined ? fallback : value;
		},
		helpers: {
			httpRequestWithAuthentication: async (_type, requestOptions) =>
				await httpRequestWithAuthentication(options.credentials, requestOptions),
		},
	};
	return { ctx, staticData };
}

/**
 * Runs the declarative credential test the way n8n does: resolve the base URL, apply the
 * credential's authenticate(), send the request and map the response with the test rules.
 */
export async function runCredentialTest(creds) {
	const test = credentialType.test;
	const baseURL = String(creds.baseUrl).trim().replace(/\/+$/, '');
	try {
		const authenticated = await credentialType.authenticate(creds, {
			...test.request,
			baseURL,
			url: test.request.url ?? '',
		});
		const response = await fakeHttpRequest({
			...authenticated,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});
		for (const rule of test.rules ?? []) {
			if (rule.type === 'responseCode' && rule.properties.value === response.statusCode) {
				return { status: 'Error', message: rule.properties.message };
			}
		}
		if (response.statusCode >= 200 && response.statusCode < 300) {
			return { status: 'OK', message: 'Connection tested successfully' };
		}
		return { status: 'Error', message: `HTTP ${response.statusCode}` };
	} catch (error) {
		return { status: 'Error', message: error.message };
	}
}
