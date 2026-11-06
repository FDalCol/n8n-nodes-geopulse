import type { IDataObject, IExecuteFunctions, IPollFunctions } from 'n8n-workflow';
import { afterEach, describe, expect, it } from 'vitest';

import { GeoPulseApi } from '../credentials/GeoPulseApi.credentials';
import { GeoPulse } from '../nodes/GeoPulse/GeoPulse.node';
import { isUnderApi, redact } from '../nodes/GeoPulse/shared/security';
import { GeoPulseTrigger } from '../nodes/GeoPulseTrigger/GeoPulseTrigger.node';
import type { ExecuteContextOptions, FakeServer, Handler } from './helpers.mjs';
import {
	SHARE_PASSWORD,
	TOKEN,
	credentials,
	executeContext,
	pollContext,
	problem,
	runCredentialTest,
	startServer,
	startTricklingServer,
} from './helpers.mjs';

const JOB_ID = '0b9f6c1e-1d2a-4a8e-9c55-6a3e1f7d2b10';

let servers: FakeServer[] = [];
afterEach(async () => {
	await Promise.all(servers.map((s) => s.close()));
	servers = [];
});

async function server(handler: Handler) {
	const s = await startServer(handler);
	servers.push(s);
	return s;
}

async function run(
	s: FakeServer,
	params: ExecuteContextOptions['params'],
	extra: Partial<ExecuteContextOptions> = {},
) {
	const { ctx, binaries } = executeContext({ params, credentials: credentials(s.url), ...extra });
	const out = await new GeoPulse().execute.call(ctx as unknown as IExecuteFunctions);
	return { items: out[0], binaries };
}

type Captured = { abortSignal?: unknown; maxResponseBodyBytes?: number; timeout?: number };

/** Runs the node while recording (and optionally changing) the options sent to n8n's helper. */
function capturing(
	baseUrl: string,
	params: Record<string, unknown>,
	override?: (options: Captured) => Captured,
) {
	const { ctx } = executeContext({ params, credentials: credentials(baseUrl) });
	const captured: Captured[] = [];
	const original = ctx.helpers.httpRequestWithAuthentication as (
		type: string,
		options: Captured,
	) => Promise<unknown>;
	const wrapped = {
		...ctx,
		helpers: {
			...ctx.helpers,
			httpRequestWithAuthentication: async (type: string, options: Captured) => {
				captured.push(options);
				return await original(type, override ? override(options) : options);
			},
		},
	};
	return {
		captured,
		run: async () =>
			(await new GeoPulse().execute.call(wrapped as unknown as IExecuteFunctions))[0],
	};
}

describe('timeouts and size limits', () => {
	it('every request has a total deadline and a response size limit', async () => {
		const s = await server((req) =>
			req.path.endsWith('/content')
				? { body: 'a,b\n', headers: { 'content-type': 'text/csv' } }
				: { json: { userId: 'u1' } },
		);
		const json = capturing(s.url, { resource: 'user', operation: 'getProfile' });
		await json.run();
		expect(json.captured[0].abortSignal).toBeInstanceOf(AbortSignal);
		expect(json.captured[0].timeout).toBe(30_000);
		expect(json.captured[0].maxResponseBodyBytes).toBe(50 * 1024 * 1024);

		const file = capturing(s.url, {
			resource: 'export',
			operation: 'download',
			exportJobId: JOB_ID,
		});
		await file.run();
		expect(file.captured[0].abortSignal).toBeInstanceOf(AbortSignal);
		expect(file.captured[0].maxResponseBodyBytes).toBe(1024 * 1024 * 1024);
	});

	it('a server that trickles the body is cut off by the deadline', async () => {
		const slow = await startTricklingServer();
		try {
			const started = Date.now();
			const call = capturing(
				slow.url,
				{ resource: 'user', operation: 'getProfile' },
				(options) => ({ ...options, abortSignal: AbortSignal.timeout(300) }),
			);
			await expect(call.run()).rejects.toThrow(/did not complete the request in time/);
			expect(Date.now() - started).toBeLessThan(3000);
		} finally {
			await slow.close();
		}
	});

	it('reports a response over the size limit', async () => {
		const s = await server(() => ({ json: { big: 'x'.repeat(2000) } }));
		const call = capturing(s.url, { resource: 'user', operation: 'getProfile' }, (options) => ({
			...options,
			maxResponseBodyBytes: 100,
		}));
		await expect(call.run()).rejects.toThrow(/response is too large/);
	});
});

describe('token and password redaction', () => {
	it('redacts a token that was pasted with surrounding whitespace', async () => {
		const s = await server(() => problem(500, 'INTERNAL_ERROR', `invalid token ${TOKEN} received`));
		const { ctx } = executeContext({
			params: { resource: 'user', operation: 'getProfile' },
			credentials: credentials(s.url, { apiToken: `  ${TOKEN}\n` }),
			continueOnFail: true,
		});
		const out = await new GeoPulse().execute.call(ctx as unknown as IExecuteFunctions);
		expect(s.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(JSON.stringify(out)).not.toContain(TOKEN);
	});

	it('redact() stays fast on long server strings, caps the length, removes short secrets', () => {
		const started = Date.now();
		const out = redact('/'.repeat(200_000), [TOKEN]);
		expect(Date.now() - started).toBeLessThan(500);
		expect(out.length).toBeLessThanOrEqual(2001);
		expect(redact('pw is x9 here', ['x9'])).not.toContain('x9');
		expect(redact(`tok ${TOKEN} end`, [`${TOKEN}\n`])).not.toContain(TOKEN);
	});

	it('removes short and nested passwords from share link output and errors', async () => {
		const s = await server((req) =>
			req.method === 'POST'
				? { json: { id: JOB_ID, settings: { password: 'x9', note: 'kept' }, has_password: true } }
				: { json: { links: [{ id: JOB_ID, nested: [{ secret_password: 'x9' }] }] } },
		);
		const params = {
			resource: 'shareLink',
			operation: 'create',
			name: 'n',
			shareType: 'LIVE_LOCATION',
			additionalFields: { password: 'x9' },
		};
		const created = await run(s, params);
		expect(JSON.stringify(created.items)).not.toContain('x9');
		expect(created.items[0].json).toMatchObject({ has_password: true, settings: { note: 'kept' } });
		const list = await run(s, { resource: 'shareLink', operation: 'getAll' });
		expect(JSON.stringify(list.items)).not.toContain('x9');

		s.setHandler(() => problem(400, 'INVALID_SHARE_LINK', 'bad password x9'));
		const failed = await run(s, params, { continueOnFail: true });
		expect(JSON.stringify(failed.items)).not.toContain('x9');
	});

	it('Custom API Call hides passwords sent in the body from output and errors', async () => {
		const s = await server((req) => ({ json: { id: 'l1', echo: req.body } }));
		const params = {
			resource: 'customApiCall',
			operation: 'request',
			method: 'POST',
			path: '/api/v1/share-links',
			sendBody: true,
			body: JSON.stringify({ name: 'n', password: SHARE_PASSWORD }),
		};
		const ok = await run(s, params);
		expect((s.requests[0].body as IDataObject).password).toBe(SHARE_PASSWORD);
		expect(JSON.stringify(ok.items)).not.toContain(SHARE_PASSWORD);

		s.setHandler(() => problem(400, 'INVALID_SHARE_LINK', `rejected ${SHARE_PASSWORD}`));
		const failed = await run(s, params, { continueOnFail: true });
		expect(JSON.stringify(failed.items)).not.toContain(SHARE_PASSWORD);
	});
});

describe('paths and URLs', () => {
	it('Custom API Call rejects ";" matrix parameters and overlong UTF-8, accepts real UTF-8', async () => {
		const s = await server(() => ({ json: { ok: true } }));
		for (const path of [
			'/api/..;/admin',
			'/api/v1/x;jsessionid=1',
			'/api/v1/%3b',
			'/api/v1/%c0%ae%c0%ae/admin',
			'/api/v1/%ff',
		]) {
			await expect(
				run(s, { resource: 'customApiCall', operation: 'request', method: 'GET', path }),
				path,
			).rejects.toThrow();
		}
		expect(s.requests).toHaveLength(0);
		await run(s, {
			resource: 'customApiCall',
			operation: 'request',
			method: 'GET',
			path: '/api/v1/location-analytics/cities/S%C3%A3o%20Paulo',
		});
		expect(s.requests[0].path).toBe('/api/v1/location-analytics/cities/S%C3%A3o%20Paulo');
	});

	it('isUnderApi() rejects matrix parameters and overlong encodings', () => {
		expect(isUnderApi('https://g.example/api/..;/admin', 'https://g.example')).toBe(false);
		expect(isUnderApi('https://g.example/api/v1/%c0%ae%c0%ae/x', 'https://g.example')).toBe(false);
		expect(isUnderApi('https://g.example/api/v1/cities/S%C3%A3o', 'https://g.example')).toBe(true);
	});

	it('authenticate() refuses protocol-relative URLs', async () => {
		const authenticate = new GeoPulseApi().authenticate as (
			c: unknown,
			o: unknown,
		) => Promise<unknown>;
		await expect(
			authenticate(
				{ baseUrl: 'https://geo.example', apiToken: TOKEN },
				{ baseURL: 'https://geo.example', url: '//evil.example/api/v1/users/me' },
			),
		).rejects.toThrow(/outside/);
	});

	it('the credential test maps 303 to the redirect message', async () => {
		const s = await server(() => ({
			status: 303,
			headers: { location: 'https://elsewhere.example/' },
		}));
		const result = await runCredentialTest(credentials(s.url));
		expect(result).toEqual({ status: 'Error', message: expect.stringMatching(/final address/) });
	});

	it('stores downloads with a safe MIME type and file name', async () => {
		const s = await server((req) =>
			req.path.endsWith('/content')
				? {
						body: '<script>alert(1)</script>',
						headers: {
							'content-type': 'text/html',
							'content-disposition': 'attachment; filename="evil.html"',
						},
					}
				: { json: {} },
		);
		const direct = await run(s, { resource: 'export', operation: 'download', exportJobId: JOB_ID });
		expect(direct.binaries[0]).toMatchObject({
			fileName: `geopulse-export-${JOB_ID}.bin`,
			mimeType: 'application/octet-stream',
		});
		await expect(
			run(s, {
				resource: 'export',
				operation: 'download',
				exportJobId: JOB_ID,
				binaryPropertyName: '__proto__',
			}),
		).rejects.toThrow(/not a valid binary property name/);
	});
});

describe('trigger with large server responses', () => {
	const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

	function poller(baseUrl: string, params: IDataObject, staticData: IDataObject) {
		const { ctx } = pollContext({ params, credentials: credentials(baseUrl), staticData });
		return async () => {
			const out = await new GeoPulseTrigger().poll.call(ctx as unknown as IPollFunctions);
			return out ? out[0].map((item) => item.json) : [];
		};
	}

	it('handles a large timeline quickly and keeps the state bounded', async () => {
		const stays = Array.from({ length: 20_000 }, (_, i) => ({
			id: i,
			timestamp: minutesAgo(20_000 - i),
			stayDuration: 30,
			locationName: `P${i}`,
			latitude: 45 + i / 1e5,
			longitude: 9,
		}));
		const s = await server(() => ({ json: { stays, trips: [], dataGaps: [] } }));
		const state: IDataObject = {};
		const poll = poller(s.url, { event: 'leftPlace' }, state);
		const started = Date.now();
		await poll();
		await poll();
		expect(Date.now() - started).toBeLessThan(5000);
		expect((state.seen as unknown[]).length).toBeLessThanOrEqual(500);
	});

	it('caps the IDs remembered at the same timestamp', async () => {
		const ts = minutesAgo(10);
		const points: IDataObject[] = [{ id: 1, timestamp: ts }];
		const s = await server((req) => {
			if (req.path === '/api/v1/gps/points/latest') return { json: points[0] };
			const page = Number(req.query.get('page'));
			const size = Number(req.query.get('size'));
			return {
				json: {
					items: points.slice((page - 1) * size, page * size),
					totalPages: Math.ceil(points.length / size),
				},
			};
		});
		const state: IDataObject = {};
		const poll = poller(s.url, { event: 'locationUpdated' }, state);
		await poll();
		for (let id = 2; id <= 1500; id++) points.push({ id, timestamp: ts });
		expect(await poll()).toHaveLength(1499);
		expect((state.pointIdsAtWatermark as unknown[]).length).toBe(1000);
	});
});
