import { afterEach, describe, expect, it } from 'vitest';

import { GeoPulseApi } from '../credentials/GeoPulseApi.credentials';
import { toUtcIso } from '../nodes/GeoPulse/shared/dates';
import {
	isUnderApi,
	normalizeApiPath,
	normalizeBaseUrl,
	redact,
	safeFileName,
} from '../nodes/GeoPulse/shared/security';
import type { FakeServer } from './helpers.mjs';
import {
	GPS_TOKEN,
	TOKEN,
	WRONG_TOKEN,
	credentials,
	problem,
	runCredentialTest,
	startServer,
} from './helpers.mjs';

let server: FakeServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe('credential test', () => {
	it('succeeds with a valid token and sends it only as Bearer header', async () => {
		server = await startServer((req) =>
			req.path === '/api/v1/api-tokens/current'
				? { json: { id: 'a1', scopes: ['read'], status: 'ACTIVE' } }
				: { status: 404 },
		);
		const result = await runCredentialTest(credentials(`${server.url}///`));
		expect(result.status).toBe('OK');
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(server.requests[0].query.toString()).toBe('');
		expect(server.violations).toEqual([]);
	});

	it('fails with a clear message for a wrong token (401)', async () => {
		server = await startServer(() => ({ json: {} }));
		const result = await runCredentialTest(credentials(server.url, { apiToken: WRONG_TOKEN }));
		expect(result.status).toBe('Error');
		expect(result.message).toMatch(/rejected the API token \(401\)/);
	});

	it('fails with a clear message for 403', async () => {
		server = await startServer(() => problem(403, 'ACCESS_DENIED', 'Denied'));
		const result = await runCredentialTest(credentials(server.url));
		expect(result).toEqual({
			status: 'Error',
			message: expect.stringMatching(/denied access \(403\)/),
		});
	});

	it('fails on a redirect and asks for the final address', async () => {
		server = await startServer(() => ({
			status: 302,
			headers: { location: 'https://elsewhere.example/' },
		}));
		const result = await runCredentialTest(credentials(server.url));
		expect(result.status).toBe('Error');
		expect(result.message).toMatch(/final address/);
	});

	it('rejects an invalid Base URL before sending anything', async () => {
		for (const baseUrl of [
			'ftp://host',
			'https://user:pw@host',
			'https://host/?a=1',
			'https://host/#x',
			'host',
		]) {
			const result = await runCredentialTest(credentials(baseUrl));
			expect(result.status, baseUrl).toBe('Error');
		}
	});
});

describe('credential authenticate()', () => {
	const cred = new GeoPulseApi();
	const auth = (creds: Record<string, unknown>, url: string) =>
		(
			cred.authenticate as (
				c: unknown,
				o: unknown,
			) => Promise<{
				headers: Record<string, string>;
				disableFollowRedirect?: boolean;
				timeout?: number;
			}>
		)(creds, { url, headers: { 'X-API-Key': 'leak', Cookie: 'session=1' } });

	it('adds Bearer, removes other auth headers and disables redirects', async () => {
		const out = await auth(
			{ baseUrl: 'https://geo.example/', apiToken: TOKEN },
			'https://geo.example/api/v1/users/me',
		);
		expect(out.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
		expect(out.disableFollowRedirect).toBe(true);
		expect(out.timeout).toBe(30_000);
	});

	it('never attaches the token outside <Base URL>/api/', async () => {
		const creds = { baseUrl: 'https://geo.example/sub', apiToken: TOKEN };
		for (const url of [
			'https://evil.example/api/v1/users/me',
			'https://geo.example/api/v1/users/me',
			'https://geo.example/sub/other',
			'http://geo.example/sub/api/v1/x',
			'https://geo.example/sub/api/%2e%2e/x',
		]) {
			await expect(auth(creds, url), url).rejects.toThrow(/outside/);
		}
		await expect(auth(creds, 'https://geo.example/sub/api/v1/x')).resolves.toBeTruthy();
	});

	it('uses the GPS source token only for the ingest endpoint', async () => {
		const creds = { baseUrl: 'https://geo.example', apiToken: TOKEN, gpsSourceToken: GPS_TOKEN };
		const ingest = await auth(creds, 'https://geo.example/api/v1/gps/ingest/home-assistant/batch');
		expect(ingest.headers.Authorization).toBe(`Bearer ${GPS_TOKEN}`);
		const other = await auth(creds, 'https://geo.example/api/v1/users/me');
		expect(other.headers.Authorization).toBe(`Bearer ${TOKEN}`);
	});
});

describe('security helpers', () => {
	it('normalizes the Base URL', () => {
		expect(normalizeBaseUrl(' https://geo.example/// ')).toBe('https://geo.example');
		expect(normalizeBaseUrl('http://192.0.2.10:8080/geopulse/')).toBe(
			'http://192.0.2.10:8080/geopulse',
		);
		expect(() => normalizeBaseUrl('javascript:alert(1)')).toThrow();
		expect(() => normalizeBaseUrl('https://a:b@geo.example')).toThrow(/username/);
	});

	it('accepts only paths under /api/', () => {
		expect(normalizeApiPath('/api/v1/timeline')).toBe('/api/v1/timeline');
		expect(normalizeApiPath('api/v1/timeline')).toBe('/api/v1/timeline');
		expect(normalizeApiPath('v1/timeline/count')).toBe('/api/v1/timeline/count');
		for (const bad of [
			'https://evil.example/api/v1',
			'//evil.example/api',
			'/api/../admin',
			'../api/v1',
			'/api/v1/%2e%2e/x',
			'/api/v1/x%2fy',
			'/other/v1',
			'/api/',
			'/api/v1/x?token=1',
			'/api/v1\\x',
			'/api//v1',
			'',
		]) {
			expect(() => normalizeApiPath(bad), bad).toThrow();
		}
	});

	it('checks URLs against the Base URL', () => {
		expect(isUnderApi('https://g.example/api/v1/x', 'https://g.example')).toBe(true);
		expect(isUnderApi('https://g.example.evil/api/v1/x', 'https://g.example')).toBe(false);
	});

	it('redacts tokens, bearer headers, passwords and query strings', () => {
		const text = `failed ${TOKEN} Authorization: Bearer abc.def password=hunter2 https://g.example/api/v1/x?from=1&key=2 /api/v1/y?z=1`;
		const out = redact(text, [TOKEN]);
		expect(out).not.toContain(TOKEN);
		expect(out).not.toContain('abc.def');
		expect(out).not.toContain('hunter2');
		expect(out).not.toContain('from=1');
		expect(out).not.toContain('z=1');
		expect(out).toContain('https://g.example/api/v1/x?[REDACTED]');
	});

	it('sanitizes file names', () => {
		expect(safeFileName('../../etc/passwd', 'x')).toBe('passwd');
		expect(safeFileName('export 2025.zip', 'x')).toBe('export 2025.zip');
		expect(safeFileName('', 'fallback.zip')).toBe('fallback.zip');
	});
});

describe('dates and time zones', () => {
	it('keeps explicit offsets and UTC', () => {
		expect(toUtcIso('2025-06-01T08:00:00Z', 'Europe/Rome', 'From')).toBe(
			'2025-06-01T08:00:00.000Z',
		);
		expect(toUtcIso('2025-06-01T08:00:00+02:00', 'UTC', 'From')).toBe('2025-06-01T06:00:00.000Z');
		expect(toUtcIso('2025-06-01T08:00:00.123-0500', 'UTC', 'From')).toBe(
			'2025-06-01T13:00:00.123Z',
		);
	});

	it('reads values without offset in the selected time zone, with DST', () => {
		expect(toUtcIso('2025-06-01 08:00', 'Europe/Rome', 'From')).toBe('2025-06-01T06:00:00.000Z');
		expect(toUtcIso('2025-01-15T08:00:00', 'Europe/Rome', 'From')).toBe('2025-01-15T07:00:00.000Z');
		expect(toUtcIso('2025-01-15', 'America/New_York', 'From')).toBe('2025-01-15T05:00:00.000Z');
		expect(toUtcIso('2025-07-15', 'America/New_York', 'From')).toBe('2025-07-15T04:00:00.000Z');
	});

	it('accepts Date objects and Luxon-like objects', () => {
		expect(toUtcIso(new Date('2025-06-01T08:00:00Z'), 'UTC', 'From')).toBe(
			'2025-06-01T08:00:00.000Z',
		);
		const luxonLike = { toISO: () => '2025-06-01T10:00:00.000+02:00' };
		expect(toUtcIso(luxonLike, 'UTC', 'From')).toBe('2025-06-01T08:00:00.000Z');
	});

	it('rejects invalid dates', () => {
		for (const bad of ['yesterday', '2025-02-30', '2025-06-01T25:00', '']) {
			expect(() => toUtcIso(bad, 'UTC', 'From'), bad).toThrow(/From is not a valid date/);
		}
	});
});
