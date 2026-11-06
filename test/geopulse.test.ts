import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { afterEach, describe, expect, it } from 'vitest';

import { GeoPulse } from '../nodes/GeoPulse/GeoPulse.node';
import type { ExecuteContextOptions, FakeServer, Handler } from './helpers.mjs';
import {
	GPS_TOKEN,
	SHARE_PASSWORD,
	TOKEN,
	WRONG_TOKEN,
	credentials,
	executeContext,
	problem,
	startServer,
} from './helpers.mjs';

let servers: FakeServer[] = [];
afterEach(async () => {
	await Promise.all(servers.map((s) => s.close()));
	servers = [];
});

async function server(handler: Handler, options?: { checkAuth?: boolean }) {
	const s = await startServer(handler, options);
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

const point = (id: number) => ({
	id,
	timestamp: new Date(Date.UTC(2025, 5, 1, 0, 0, id)).toISOString(),
	coordinates: { lat: 45 + id / 1000, lng: 9 },
	sourceType: 'OWNTRACKS',
});

function pagedPoints(total: number): Handler {
	const all = Array.from({ length: total }, (_, i) => point(i + 1));
	return (req) => {
		if (req.path !== '/api/v1/gps/points') return { status: 404 };
		const page = Number(req.query.get('page'));
		const size = Number(req.query.get('size'));
		const items = all.slice((page - 1) * size, page * size);
		return {
			json: { items, page, size, totalElements: total, totalPages: Math.ceil(total / size) },
		};
	};
}

describe('Location', () => {
	it('Get Last Location returns the point, or found=false when empty', async () => {
		const s = await server((req) =>
			req.path === '/api/v1/gps/points/latest' ? { json: point(7) } : { status: 404 },
		);
		const { items } = await run(s, { resource: 'location', operation: 'getLastLocation' });
		expect(items).toEqual([{ json: { found: true, ...point(7) }, pairedItem: { item: 0 } }]);

		s.setHandler(() => ({ status: 200, body: '' }));
		const empty = await run(s, { resource: 'location', operation: 'getLastLocation' });
		expect(empty.items[0].json.found).toBe(false);
		expect(s.violations).toEqual([]);
	});

	it('Get GPS Points with Return All reads every page', async () => {
		const s = await server(pagedPoints(2500));
		const { items } = await run(s, {
			resource: 'location',
			operation: 'getPoints',
			returnAll: true,
			from: '2025-06-01T00:00:00Z',
			to: '2025-06-02T00:00:00Z',
		});
		expect(items).toHaveLength(2500);
		expect(s.requests.map((r) => r.query.get('page'))).toEqual(['1', '2', '3']);
		expect(s.requests[0].query.get('size')).toBe('1000');
		expect(s.requests[0].query.get('from')).toBe('2025-06-01T00:00:00.000Z');
		expect(s.requests[0].query.get('sortDirection')).toBe('desc');
	});

	it('Get GPS Points with Limit stops early and uses a matching page size', async () => {
		const s = await server(pagedPoints(500));
		const { items } = await run(s, {
			resource: 'location',
			operation: 'getPoints',
			returnAll: false,
			limit: 30,
		});
		expect(items).toHaveLength(30);
		expect(s.requests).toHaveLength(1);
		expect(s.requests[0].query.get('size')).toBe('30');
	});

	it('Split Into Items off returns one item with an array', async () => {
		const s = await server(pagedPoints(3));
		const { items } = await run(s, {
			resource: 'location',
			operation: 'getPoints',
			returnAll: true,
			splitIntoItems: false,
		});
		expect(items).toHaveLength(1);
		expect(items[0].json.count).toBe(3);
		expect(Array.isArray(items[0].json.items)).toBe(true);
	});

	it('stops when the server ignores the page parameter', async () => {
		const s = await server((req) => {
			const size = Number(req.query.get('size'));
			const items = Array.from({ length: size }, (_, i) => point(i + 1));
			return { json: { items, page: 1, size, totalPages: 99 } };
		});
		await expect(
			run(s, { resource: 'location', operation: 'getPoints', returnAll: true }),
		).rejects.toThrow(/same page twice/);
		expect(s.requests).toHaveLength(2);
	});

	it('caps the number of pages', async () => {
		let next = 0;
		const s = await server((req) => {
			const size = Number(req.query.get('size'));
			const items = Array.from({ length: size }, () => point(++next));
			return { json: { items, totalPages: 1_000_000 } };
		});
		await expect(
			run(s, { resource: 'location', operation: 'getPoints', returnAll: false, limit: 1_000_000 }),
		).rejects.toThrow(/Stopped after 200 pages/);
		expect(s.requests).toHaveLength(200);
	});

	it('interprets dates in the selected or workflow time zone', async () => {
		const s = await server(() => ({ json: { totalPoints: 1 } }));
		await run(
			s,
			{
				resource: 'location',
				operation: 'getSummary',
				from: '2025-06-01 00:00',
				to: '2025-06-01T23:59:59',
				options: { timeZone: 'Europe/Rome' },
			},
			{ timezone: 'UTC' },
		);
		expect(s.requests[0].query.get('from')).toBe('2025-05-31T22:00:00.000Z');
		expect(s.requests[0].query.get('to')).toBe('2025-06-01T21:59:59.000Z');

		await run(
			s,
			{ resource: 'location', operation: 'getSummary', from: '2025-01-10 12:00' },
			{ timezone: 'America/New_York' },
		);
		expect(s.requests[1].query.get('from')).toBe('2025-01-10T17:00:00.000Z');
		expect(s.requests[1].query.has('to')).toBe(false);

		await expect(
			run(s, { resource: 'location', operation: 'getSummary', options: { timeZone: 'Mars/Base' } }),
		).rejects.toThrow(/Unknown time zone/);
		await expect(
			run(s, {
				resource: 'location',
				operation: 'getSummary',
				from: '2025-06-02T00:00Z',
				to: '2025-06-01T00:00Z',
			}),
		).rejects.toThrow(/From must be before To/);
	});

	it('Get Path, Get Point Place and Get Current Status call the verified endpoints', async () => {
		const s = await server((req) => {
			if (req.path === '/api/v1/gps/points/path')
				return { json: { pointCount: 2, points: [{}, {}], segments: [[{}, {}]] } };
			if (req.path === '/api/v1/gps/points/42/location') return { json: { locationName: 'Home' } };
			if (req.path === '/api/v1/users/me/status') return { json: { state: 'STAY' } };
			return { status: 404 };
		});
		const path = await run(s, {
			resource: 'location',
			operation: 'getPath',
			options: { simplify: false },
		});
		expect(path.items[0].json.pointCount).toBe(2);
		expect(s.requests[0].query.get('simplify')).toBe('false');
		const place = await run(s, { resource: 'location', operation: 'getPointPlace', pointId: 42 });
		expect(place.items[0].json).toEqual({ pointId: 42, locationName: 'Home' });
		const status = await run(s, { resource: 'location', operation: 'getCurrentStatus' });
		expect(status.items[0].json.state).toBe('STAY');
	});
});

const TIMELINE = {
	stays: [
		{
			id: 1,
			timestamp: '2025-06-01T08:00:00Z',
			stayDuration: 3600,
			locationName: 'Home',
			latitude: 45,
			longitude: 9,
		},
		{
			id: 3,
			timestamp: '2025-06-01T10:00:00Z',
			stayDuration: 600,
			locationName: 'Office',
			latitude: 45.1,
			longitude: 9.1,
		},
	],
	trips: [
		{
			id: 2,
			timestamp: '2025-06-01T09:00:00Z',
			tripDuration: 3600,
			distanceMeters: 5000,
			movementType: 'CAR',
			latitude: 45,
			longitude: 9,
			endLatitude: 45.1,
			endLongitude: 9.1,
		},
	],
	dataGaps: [
		{
			id: 4,
			startTime: '2025-06-01T07:00:00Z',
			endTime: '2025-06-01T08:00:00Z',
			durationSeconds: 3600,
		},
	],
};

describe('Timeline', () => {
	it('Get Timeline merges stays, trips and gaps chronologically', async () => {
		const s = await server((req) =>
			req.path === '/api/v1/timeline' ? { json: TIMELINE } : { status: 404 },
		);
		const { items } = await run(s, { resource: 'timeline', operation: 'getTimeline' });
		expect(items.map((i) => [i.json.type, i.json.id])).toEqual([
			['dataGap', 4],
			['stay', 1],
			['trip', 2],
			['stay', 3],
		]);
		expect(items[1].json.endTime).toBe('2025-06-01T09:00:00.000Z');
	});

	it('Get Stays / Trips / Data Gaps filter by type', async () => {
		const s = await server(() => ({ json: TIMELINE }));
		expect((await run(s, { resource: 'timeline', operation: 'getStays' })).items).toHaveLength(2);
		expect((await run(s, { resource: 'timeline', operation: 'getTrips' })).items).toHaveLength(1);
		const gaps = await run(s, {
			resource: 'timeline',
			operation: 'getDataGaps',
			splitIntoItems: false,
		});
		expect(gaps.items[0].json.count).toBe(1);
	});

	it('Get Statistics calls /statistics with the period', async () => {
		const s = await server(() => ({
			json: { totalDistanceMeters: 1234, timeMoving: 60, places: [] },
		}));
		const { items } = await run(s, {
			resource: 'timeline',
			operation: 'getStatistics',
			from: '2025-06-01T00:00:00Z',
			to: '2025-06-08T00:00:00Z',
		});
		expect(s.requests[0].path).toBe('/api/v1/statistics');
		expect(items[0].json.totalDistanceMeters).toBe(1234);
	});

	it('Regenerate Timeline starts a job and can wait for it', async () => {
		let polls = 0;
		const s = await server((req) => {
			if (req.method === 'POST' && req.path === '/api/v1/timeline/jobs')
				return { json: { jobId: 'job-1' } };
			if (req.path === '/api/v1/timeline/jobs/job-1') {
				polls++;
				return {
					json: {
						jobId: 'job-1',
						status: polls < 2 ? 'RUNNING' : 'COMPLETED',
						progressPercentage: 100,
					},
				};
			}
			return { status: 404 };
		});
		const quick = await run(s, { resource: 'timeline', operation: 'regenerate' });
		expect(quick.items[0].json).toEqual({ jobId: 'job-1', status: 'QUEUED' });

		const waited = await run(s, {
			resource: 'timeline',
			operation: 'regenerate',
			waitForCompletion: true,
			pollInterval: 1,
			waitTimeout: 30,
		});
		expect(waited.items[0].json.status).toBe('COMPLETED');
		expect(polls).toBe(2);
	});

	it('rejects wait values outside 1 s – 24 h, also from expressions', async () => {
		const s = await server(() => ({ json: { jobId: 'job-1' } }));
		for (const [pollInterval, waitTimeout] of [
			[0, 10],
			[1, 86_401],
			['abc', 10],
		]) {
			await expect(
				run(s, {
					resource: 'timeline',
					operation: 'regenerate',
					waitForCompletion: true,
					pollInterval,
					waitTimeout,
				}),
			).rejects.toThrow(/between 1 and 86400/);
		}
		expect(s.requests).toHaveLength(0);
	});
});

describe('Ingestion', () => {
	it('Send Location (single) uses the Home Assistant batch format', async () => {
		const s = await server(() => ({ json: { accepted: 1, saved: 1, duplicate: 0, filtered: 0 } }));
		const { items } = await run(s, {
			resource: 'ingestion',
			operation: 'sendLocation',
			inputMode: 'single',
			latitude: 45.4642,
			longitude: 9.19,
			timestamp: '2025-06-01 10:00',
			additionalFields: {
				accuracy: 5,
				altitude: 120.4,
				speed: 2.5,
				battery: 87.6,
				deviceId: 'phone',
			},
			options: { timeZone: 'Europe/Rome' },
		});
		expect(s.requests[0].method).toBe('POST');
		expect(s.requests[0].path).toBe('/api/v1/gps/ingest/home-assistant/batch');
		expect(s.requests[0].body).toEqual([
			{
				device_id: 'phone',
				timestamp: '2025-06-01T08:00:00.000Z',
				location: { latitude: 45.4642, longitude: 9.19, accuracy: 5, altitude: 120.4, speed: 2.5 },
				battery: { level: 88 },
			},
		]);
		expect(items[0].json).toMatchObject({ sent: 1, saved: 1, requests: 1 });
	});

	it('Send Location (multiple) splits more than 1000 points and sums the results', async () => {
		const s = await server((req) => {
			const n = (req.body as unknown[]).length;
			return { json: { accepted: n, saved: n - 1, duplicate: 1, filtered: 0 } };
		});
		const points = Array.from({ length: 1500 }, (_, i) => ({
			lat: 45,
			lon: 9,
			timestamp: new Date(Date.UTC(2025, 5, 1, 0, 0, i)).toISOString(),
		}));
		const { items } = await run(s, {
			resource: 'ingestion',
			operation: 'sendLocation',
			inputMode: 'multiple',
			points: JSON.stringify(points),
		});
		expect(s.requests.map((r) => (r.body as unknown[]).length)).toEqual([1000, 500]);
		expect(items[0].json).toMatchObject({
			sent: 1500,
			accepted: 1500,
			saved: 1498,
			duplicate: 2,
			requests: 2,
		});
	});

	it('uses the optional GPS source token for ingestion only', async () => {
		const s = await server(() => ({ json: { accepted: 1, saved: 1, duplicate: 0, filtered: 0 } }));
		const { ctx } = executeContext({
			params: {
				resource: 'ingestion',
				operation: 'sendLocation',
				inputMode: 'multiple',
				points: [{ latitude: 1, longitude: 2, timestamp: '2025-06-01T00:00:00Z' }],
			},
			credentials: credentials(s.url, { gpsSourceToken: GPS_TOKEN }),
		});
		await new GeoPulse().execute.call(ctx as unknown as IExecuteFunctions);
		expect(s.requests[0].headers.authorization).toBe(`Bearer ${GPS_TOKEN}`);
	});

	it('validates points before sending', async () => {
		const s = await server(() => ({ json: {} }));
		for (const points of [
			[{ latitude: 91, longitude: 0, timestamp: '2025-06-01T00:00:00Z' }],
			[{ latitude: 1, longitude: 2 }],
			[{ latitude: 1, longitude: 2, timestamp: '2025-06-01T00:00:00Z', battery: 120 }],
			'not json',
			[],
		]) {
			await expect(
				run(s, { resource: 'ingestion', operation: 'sendLocation', inputMode: 'multiple', points }),
			).rejects.toThrow();
		}
		expect(s.requests).toHaveLength(0);
	});
});

const JOB_ID = '0b9f6c1e-1d2a-4a8e-9c55-6a3e1f7d2b10';

describe('Export', () => {
	it('Create Export without waiting returns the job', async () => {
		const s = await server(() => ({ json: { exportJobId: JOB_ID, status: 'processing' } }));
		const { items } = await run(s, {
			resource: 'export',
			operation: 'create',
			format: 'gpx',
			gpxLayout: 'zip-per-day',
			from: '2025-06-01T00:00:00Z',
			to: '2025-06-30T23:59:59Z',
		});
		expect(s.requests[0].body).toEqual({
			format: 'gpx',
			startTime: '2025-06-01T00:00:00.000Z',
			endTime: '2025-06-30T23:59:59.000Z',
			gpxLayout: 'zip-per-day',
		});
		expect(items[0].json.exportJobId).toBe(JOB_ID);
	});

	it('waits for completion and downloads the file as binary data', async () => {
		let polls = 0;
		const s = await server((req) => {
			if (req.method === 'POST')
				return { json: { exportJobId: JOB_ID, status: 'processing', format: 'geopulse' } };
			if (req.path === `/api/v1/exports/${JOB_ID}`) {
				polls++;
				return {
					json: {
						exportJobId: JOB_ID,
						status: polls < 2 ? 'processing' : 'completed',
						format: 'geopulse',
					},
				};
			}
			if (req.path === `/api/v1/exports/${JOB_ID}/content`) {
				return {
					body: Buffer.from('PK\u0003\u0004zipdata'),
					headers: {
						'content-type': 'application/zip',
						'content-disposition': 'attachment; filename="../geopulse-export.zip"',
					},
				};
			}
			return { status: 404 };
		});
		const { items, binaries } = await run(s, {
			resource: 'export',
			operation: 'create',
			format: 'geopulse',
			dataTypes: ['rawgps', 'timeline'],
			from: '2025-06-01T00:00:00Z',
			to: '2025-06-02T00:00:00Z',
			waitForCompletion: true,
			pollInterval: 1,
			waitTimeout: 60,
			download: true,
			binaryPropertyName: 'file',
		});
		expect((s.requests[0].body as IDataObject).dataTypes).toEqual(['rawgps', 'timeline']);
		expect(items[0].binary?.file).toBeDefined();
		expect(binaries).toEqual([
			{ fileName: 'geopulse-export.zip', mimeType: 'application/zip', size: 11 },
		]);
		expect(items[0].json).toMatchObject({
			status: 'completed',
			fileName: 'geopulse-export.zip',
			fileSizeBytes: 11,
		});
	});

	it('fails when the export does not finish within the timeout', async () => {
		const s = await server(() => ({ json: { exportJobId: JOB_ID, status: 'processing' } }));
		const started = Date.now();
		await expect(
			run(s, {
				resource: 'export',
				operation: 'create',
				format: 'csv',
				from: '2025-06-01T00:00:00Z',
				to: '2025-06-02T00:00:00Z',
				waitForCompletion: true,
				pollInterval: 1,
				waitTimeout: 1,
			}),
		).rejects.toThrow(/did not finish within 1 seconds/);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it('Get Export Status and Download Export validate the job ID', async () => {
		const s = await server((req) =>
			req.path.endsWith('/content')
				? { body: 'a,b\n1,2\n', headers: { 'content-type': 'text/csv; charset=utf-8' } }
				: { json: { exportJobId: JOB_ID, status: 'completed' } },
		);
		const status = await run(s, {
			resource: 'export',
			operation: 'getStatus',
			exportJobId: JOB_ID,
		});
		expect(status.items[0].json.status).toBe('completed');
		const file = await run(s, {
			resource: 'export',
			operation: 'download',
			exportJobId: JOB_ID,
			binaryPropertyName: 'data',
		});
		expect(file.binaries[0]).toEqual({
			fileName: `geopulse-export-${JOB_ID}.bin`,
			mimeType: 'text/csv',
			size: 8,
		});
		await expect(
			run(s, { resource: 'export', operation: 'download', exportJobId: '../x' }),
		).rejects.toThrow(/UUID/);
	});
});

describe('Share links and friends', () => {
	const LINK_ID = '11111111-2222-3333-4444-555555555555';

	it('lists share links with their public URL', async () => {
		const s = await server(() => ({
			json: {
				links: [
					{ id: LINK_ID, name: 'Live', share_type: 'LIVE_LOCATION', has_password: true },
					{ id: 'abc', name: 'Trip', share_type: 'TIMELINE' },
				],
				base_url: 'https://share.example',
			},
		}));
		const { items } = await run(s, { resource: 'shareLink', operation: 'getAll' });
		expect(items.map((i) => i.json.url)).toEqual([
			`https://share.example/shared/${LINK_ID}`,
			'https://share.example/shared-timeline/abc',
		]);
	});

	it('creates a link with password and expiration, never returning the password', async () => {
		const s = await server((req) => {
			if (req.method === 'POST')
				return {
					json: { id: LINK_ID, name: 'Live', has_password: true, password: 'should-not-leak' },
				};
			return { json: { links: [], base_url: null } };
		});
		const expires = new Date(Date.now() + 86_400_000).toISOString();
		const { items } = await run(s, {
			resource: 'shareLink',
			operation: 'create',
			name: 'Live',
			shareType: 'LIVE_LOCATION',
			additionalFields: {
				password: SHARE_PASSWORD,
				expiresAt: expires,
				showHistory: true,
				historyHours: 6,
			},
		});
		expect(s.requests[0].body).toEqual({
			name: 'Live',
			share_type: 'LIVE_LOCATION',
			password: SHARE_PASSWORD,
			expires_at: expires,
			show_history: true,
			history_hours: 6,
		});
		expect(JSON.stringify(items)).not.toMatch(new RegExp(`${SHARE_PASSWORD}|should-not-leak`));
		expect(items[0].json.url).toBe(`${s.url}/shared/${LINK_ID}`);
	});

	it('redacts the share link password from errors', async () => {
		const s = await server(() =>
			problem(400, 'INVALID_SHARE_LINK', `Password ${SHARE_PASSWORD} is too weak`),
		);
		const { items } = await run(
			s,
			{
				resource: 'shareLink',
				operation: 'create',
				name: 'x',
				shareType: 'LIVE_LOCATION',
				additionalFields: { password: SHARE_PASSWORD },
			},
			{ continueOnFail: true },
		);
		expect(JSON.stringify(items)).not.toContain(SHARE_PASSWORD);
		expect(items[0].json.error).toMatch(/INVALID_SHARE_LINK/);
	});

	it('creates a timeline link and deletes a link', async () => {
		const s = await server((req) =>
			req.method === 'DELETE' ? { status: 204 } : { json: { id: LINK_ID } },
		);
		await run(s, {
			resource: 'shareLink',
			operation: 'create',
			name: 'June',
			shareType: 'TIMELINE',
			startDate: '2025-06-01',
			endDate: '2025-06-30',
			additionalFields: { showNotes: true },
		});
		expect(s.requests[0].body).toMatchObject({
			share_type: 'TIMELINE',
			start_date: '2025-06-01T00:00:00.000Z',
			end_date: '2025-06-30T00:00:00.000Z',
			show_notes: true,
		});
		const deleted = await run(s, {
			resource: 'shareLink',
			operation: 'delete',
			shareLinkId: LINK_ID,
		});
		expect(deleted.items[0].json).toEqual({ id: LINK_ID, deleted: true });
		expect(s.requests.at(-1)).toMatchObject({
			method: 'DELETE',
			path: `/api/v1/share-links/${LINK_ID}`,
		});
	});

	it('lists friends and gets a friend location', async () => {
		const s = await server((req) =>
			req.path === '/api/v1/friends'
				? { json: [{ friendId: LINK_ID, fullName: 'Alex' }] }
				: { json: { latitude: 45, longitude: 9, timestamp: '2025-06-01T00:00:00Z' } },
		);
		const list = await run(s, { resource: 'friend', operation: 'getAll' });
		expect(list.items[0].json.fullName).toBe('Alex');
		const loc = await run(s, { resource: 'friend', operation: 'getLocation', friendId: LINK_ID });
		expect(loc.items[0].json).toMatchObject({ friendId: LINK_ID, found: true, latitude: 45 });
		expect(s.requests[1].path).toBe(`/api/v1/friends/${LINK_ID}/location`);
	});
});

describe('User and Custom API Call', () => {
	it('Get Profile', async () => {
		const s = await server(() => ({ json: { userId: 'u1', email: 'a@b.c' } }));
		const { items } = await run(s, { resource: 'user', operation: 'getProfile' });
		expect(s.requests[0].path).toBe('/api/v1/users/me');
		expect(items[0].json.userId).toBe('u1');
	});

	it('Custom API Call sends method, path, query and body', async () => {
		const s = await server((req) => ({ json: { echo: req.body, q: req.query.get('from') } }));
		const { items } = await run(s, {
			resource: 'customApiCall',
			operation: 'request',
			method: 'POST',
			path: 'v1/timeline/count',
			queryParameters: { parameter: [{ name: 'from', value: '2025-01-01T00:00:00Z' }] },
			sendBody: true,
			body: '{"a":1}',
		});
		expect(s.requests[0]).toMatchObject({ method: 'POST', path: '/api/v1/timeline/count' });
		expect(items[0].json).toEqual({ echo: { a: 1 }, q: '2025-01-01T00:00:00Z' });
	});

	it('Custom API Call rejects invalid paths without sending anything', async () => {
		const s = await server(() => ({ json: {} }));
		for (const path of [
			'https://evil.example/api/v1',
			'//evil.example',
			'/api/../x',
			'../etc',
			'/other',
			'/api/v1/%2e%2e/admin',
		]) {
			await expect(
				run(s, { resource: 'customApiCall', operation: 'request', method: 'GET', path }),
				path,
			).rejects.toThrow();
		}
		await expect(
			run(s, {
				resource: 'customApiCall',
				operation: 'request',
				method: 'GET',
				path: '/api/v1/x',
				queryParameters: { parameter: [{ name: 'api_key', value: 'x' }] },
			}),
		).rejects.toThrow(/not allowed/);
		expect(s.requests).toHaveLength(0);
	});
});

describe('Errors', () => {
	it('maps 401, 403 scope, 403 and 404 to clear messages', async () => {
		const s = await server(() => ({ json: {} }));
		const { ctx } = executeContext({
			params: { resource: 'user', operation: 'getProfile' },
			credentials: credentials(s.url, { apiToken: WRONG_TOKEN }),
		});
		await expect(new GeoPulse().execute.call(ctx as unknown as IExecuteFunctions)).rejects.toThrow(
			/rejected the API token \(401\)/,
		);

		s.setHandler(() =>
			problem(403, 'API_TOKEN_SCOPE_REQUIRED', "This API token does not have the 'write' scope.", {
				requiredScope: 'write',
			}),
		);
		await expect(run(s, { resource: 'timeline', operation: 'regenerate' })).rejects.toThrow(
			/missing the 'write' scope/,
		);

		s.setHandler(() => ({
			...problem(403, 'API_TOKEN_SCOPE_REQUIRED', 'scope'),
			headers: {
				'content-type': 'application/problem+json',
				'x-geopulse-required-scope': 'export',
			},
		}));
		await expect(
			run(s, { resource: 'export', operation: 'getStatus', exportJobId: JOB_ID }),
		).rejects.toThrow(/'export' scope/);

		s.setHandler(() => problem(403, 'FRIEND_LOCATION_ACCESS_DENIED', 'Not shared'));
		await expect(
			run(s, { resource: 'friend', operation: 'getLocation', friendId: JOB_ID }),
		).rejects.toThrow(/denied access \(403 FRIEND_LOCATION_ACCESS_DENIED\): Not shared/);

		s.setHandler(() => problem(404, 'EXPORT_NOT_FOUND', 'Export job not found'));
		await expect(
			run(s, { resource: 'export', operation: 'getStatus', exportJobId: JOB_ID }),
		).rejects.toThrow(/Not found \(404 EXPORT_NOT_FOUND\): Export job not found/);
	});

	it('continueOnFail returns { error } per item with pairedItem', async () => {
		const s = await server((req) =>
			req.path === '/api/v1/gps/points/2/location'
				? problem(404, 'GPS_POINT_NOT_FOUND', 'Point not found')
				: { json: { locationName: 'Home' } },
		);
		const { items } = await run(
			s,
			{ resource: 'location', operation: 'getPointPlace', pointId: (i: number) => i + 1 },
			{ continueOnFail: true, items: [{ json: {} }, { json: {} }, { json: {} }] },
		);
		expect(items).toHaveLength(3);
		expect(items[1]).toEqual({
			json: {
				error: 'Not found (404 GPS_POINT_NOT_FOUND): Point not found',
				errorDetails: 'errorId e-1, requestId r-1',
			},
			pairedItem: { item: 1 },
		});
		expect(items[2].json.locationName).toBe('Home');
	});

	it('never follows a redirect to another host', async () => {
		const other = await server(() => ({ json: { stolen: true } }), { checkAuth: false });
		const s = await server(() => ({
			status: 302,
			headers: { location: `${other.url}/api/v1/users/me?x=1` },
		}));
		await expect(run(s, { resource: 'user', operation: 'getProfile' })).rejects.toThrow(
			/redirect \(HTTP 302 to http:\/\/127\.0\.0\.1:\d+\).*final address/,
		);
		expect(other.requests).toHaveLength(0);
		const { items } = await run(
			s,
			{ resource: 'user', operation: 'getProfile' },
			{ continueOnFail: true },
		);
		expect(String(items[0].json.error)).not.toContain('x=1');
		expect(other.requests).toHaveLength(0);
	});

	it('redacts the token from error messages and continueOnFail output', async () => {
		const s = await server(() =>
			problem(500, 'INTERNAL_ERROR', `boom with ${TOKEN} at /api/v1/x?secret=1`),
		);
		const { items } = await run(
			s,
			{ resource: 'user', operation: 'getProfile' },
			{ continueOnFail: true },
		);
		const text = JSON.stringify(items);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain('secret=1');
		expect(text).toContain('[REDACTED]');
		await expect(run(s, { resource: 'user', operation: 'getProfile' })).rejects.toSatisfy(
			(error: Error) => !error.message.includes(TOKEN) && !JSON.stringify(error).includes(TOKEN),
		);
	});

	it('redacts the token from network errors', async () => {
		const { ctx } = executeContext({
			params: { resource: 'user', operation: 'getProfile' },
			credentials: credentials('http://127.0.0.1:1'),
			continueOnFail: true,
		});
		const failing = {
			...ctx,
			helpers: {
				...ctx.helpers,
				httpRequestWithAuthentication: async () => {
					throw Object.assign(
						new Error(`connect ECONNREFUSED with header Authorization: Bearer ${TOKEN}`),
						{
							code: 'ECONNREFUSED',
							config: { headers: { Authorization: `Bearer ${TOKEN}` } },
						},
					);
				},
			},
		};
		const out = await new GeoPulse().execute.call(failing as unknown as IExecuteFunctions);
		expect(JSON.stringify(out)).not.toContain(TOKEN);
		expect(out[0][0].json.error).toMatch(/Connection to GeoPulse refused/);
	});

	it('reports an HTML page as a wrong Base URL', async () => {
		const s = await server(() => ({
			body: '<html>app</html>',
			headers: { 'content-type': 'text/html' },
		}));
		await expect(run(s, { resource: 'user', operation: 'getProfile' })).rejects.toThrow(
			/HTML page/,
		);
	});
});
