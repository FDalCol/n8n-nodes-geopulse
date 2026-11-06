import type { IDataObject, IPollFunctions } from 'n8n-workflow';
import { afterEach, describe, expect, it } from 'vitest';

import { GeoPulseTrigger } from '../nodes/GeoPulseTrigger/GeoPulseTrigger.node';
import type { FakeServer } from './helpers.mjs';
import { credentials, pollContext, startServer } from './helpers.mjs';

let s: FakeServer | undefined;
afterEach(async () => {
	await s?.close();
	s = undefined;
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface Timeline {
	stays: IDataObject[];
	trips: IDataObject[];
	dataGaps: IDataObject[];
}

function stay(
	id: number,
	startMinAgo: number,
	durationMin: number,
	name: string,
	lat = 45,
	lng = 9,
) {
	return {
		id,
		timestamp: minutesAgo(startMinAgo),
		stayDuration: durationMin * 60,
		locationName: name,
		latitude: lat,
		longitude: lng,
	};
}

function trip(
	id: number,
	startMinAgo: number,
	durationMin: number,
	lat = 45,
	lng = 9,
	endLat = 45.1,
	endLng = 9.1,
) {
	return {
		id,
		timestamp: minutesAgo(startMinAgo),
		tripDuration: durationMin * 60,
		latitude: lat,
		longitude: lng,
		endLatitude: endLat,
		endLongitude: endLng,
	};
}

async function timelineServer(timeline: Timeline) {
	s = await startServer((req) =>
		req.path === '/api/v1/timeline' ? { json: timeline } : { status: 404 },
	);
	return s;
}

function poller(
	params: IDataObject,
	staticData: IDataObject,
	mode: 'manual' | 'trigger' = 'trigger',
) {
	const { ctx } = pollContext({ params, credentials: credentials(s!.url), staticData, mode });
	return async () => {
		const out = await new GeoPulseTrigger().poll.call(ctx as unknown as IPollFunctions);
		return out ? out[0].map((item) => item.json) : [];
	};
}

describe('GeoPulse Trigger – timeline events', () => {
	it('Arrived At Place: first run saves state without events, then emits new stays once', async () => {
		const timeline: Timeline = {
			stays: [stay(1, 300, 60, 'Home')],
			trips: [trip(2, 240, 30)],
			dataGaps: [],
		};
		await timelineServer(timeline);
		const state: IDataObject = {};
		const poll = poller({ event: 'arrivedAtPlace', placeFilter: 'none' }, state);

		expect(await poll()).toEqual([]);
		expect(state.initialized).toBe(true);

		timeline.stays.push(stay(3, 200, 5, 'Office', 45.1, 9.1));
		const events = await poll();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: 'arrivedAtPlace',
			type: 'stay',
			id: 3,
			locationName: 'Office',
		});
		expect(await poll()).toEqual([]);
		expect(s!.requests[0].query.get('from')).toBeTruthy();
	});

	it('does not re-emit stays recalculated by a timeline regeneration', async () => {
		const timeline: Timeline = { stays: [stay(1, 300, 60, 'Home')], trips: [], dataGaps: [] };
		await timelineServer(timeline);
		const state: IDataObject = {};
		const poll = poller({ event: 'arrivedAtPlace' }, state);
		await poll();
		timeline.stays.push(stay(3, 120, 10, 'Office', 45.1, 9.1));
		expect(await poll()).toHaveLength(1);

		// Regeneration: new IDs, start times shifted by a couple of minutes, same places.
		timeline.stays = [stay(101, 302, 62, 'Home'), stay(103, 118, 12, 'Office', 45.1, 9.1)];
		expect(await poll()).toEqual([]);
	});

	it('filters by radius and by place name', async () => {
		const timeline: Timeline = { stays: [], trips: [], dataGaps: [] };
		await timelineServer(timeline);
		const radiusState: IDataObject = {};
		const nameState: IDataObject = {};
		const byRadius = poller(
			{
				event: 'arrivedAtPlace',
				placeFilter: 'radius',
				latitude: 45.4642,
				longitude: 9.19,
				radius: 500,
			},
			radiusState,
		);
		const byName = poller(
			{ event: 'arrivedAtPlace', placeFilter: 'placeName', placeName: 'gym' },
			nameState,
		);
		await byRadius();
		await byName();

		timeline.stays.push(stay(1, 100, 10, 'Duomo', 45.465, 9.191));
		timeline.stays.push(stay(2, 50, 10, 'City Gym', 45.6, 9.5));
		expect((await byRadius()).map((e) => e.id)).toEqual([1]);
		expect((await byName()).map((e) => e.id)).toEqual([2]);
	});

	it('Left Place and New Trip fire only when the next element starts', async () => {
		const timeline: Timeline = { stays: [stay(1, 100, 30, 'Home')], trips: [], dataGaps: [] };
		await timelineServer(timeline);
		const leftState: IDataObject = {};
		const tripState: IDataObject = {};
		const left = poller({ event: 'leftPlace' }, leftState);
		const newTrip = poller({ event: 'newTrip' }, tripState);
		await left();
		await newTrip();

		timeline.trips.push(trip(2, 70, 20));
		expect((await left()).map((e) => e.id)).toEqual([1]);
		expect(await newTrip()).toEqual([]);

		timeline.stays.push(stay(3, 50, 5, 'Office', 45.1, 9.1));
		const trips = await newTrip();
		expect(trips).toHaveLength(1);
		expect(trips[0]).toMatchObject({ event: 'newTrip', type: 'trip', id: 2 });
		expect(await left()).toEqual([]);
	});

	it('manual mode returns the most recent element without touching the state', async () => {
		const timeline: Timeline = {
			stays: [stay(1, 300, 60, 'Home'), stay(3, 100, 10, 'Office', 45.1, 9.1)],
			trips: [trip(2, 200, 30)],
			dataGaps: [],
		};
		await timelineServer(timeline);
		const state: IDataObject = {};
		const events = await poller({ event: 'arrivedAtPlace' }, state, 'manual')();
		expect(events).toHaveLength(1);
		expect(events[0].id).toBe(3);
		expect(state).toEqual({});
		const trips = await poller({ event: 'newTrip' }, state, 'manual')();
		expect(trips[0].id).toBe(2);
	});
});

describe('GeoPulse Trigger – Location Updated', () => {
	it('emits new points once, dedupes by ID and applies the radius filter', async () => {
		const points: IDataObject[] = [
			{ id: 10, timestamp: minutesAgo(30), coordinates: { lat: 45, lng: 9 } },
		];
		s = await startServer((req) => {
			if (req.path === '/api/v1/gps/points/latest') return { json: points[points.length - 1] };
			if (req.path === '/api/v1/gps/points') {
				const from = Date.parse(req.query.get('from') ?? '');
				const items = points.filter(
					(p) => !Number.isFinite(from) || Date.parse(String(p.timestamp)) >= from,
				);
				return { json: { items, page: 1, size: 1000, totalPages: 1 } };
			}
			return { status: 404 };
		});
		const state: IDataObject = {};
		const poll = poller({ event: 'locationUpdated', placeFilter: 'none' }, state);
		expect(await poll()).toEqual([]);
		expect(state.pointWatermark).toBe(points[0].timestamp);

		const sameTime = String(points[0].timestamp);
		points.push({ id: 11, timestamp: sameTime, coordinates: { lat: 45, lng: 9 } });
		points.push({ id: 12, timestamp: minutesAgo(5), coordinates: { lat: 46, lng: 10 } });
		expect((await poll()).map((p) => p.id)).toEqual([11, 12]);
		expect(await poll()).toEqual([]);
		expect(s.requests.at(-1)?.query.get('sortDirection')).toBe('asc');

		const nearState: IDataObject = {};
		const near = poller(
			{ event: 'locationUpdated', placeFilter: 'radius', latitude: 45, longitude: 9, radius: 1000 },
			nearState,
		);
		await near();
		points.push({ id: 13, timestamp: minutesAgo(2), coordinates: { lat: 45.001, lng: 9 } });
		points.push({ id: 14, timestamp: minutesAgo(1), coordinates: { lat: 48, lng: 2 } });
		expect((await near()).map((p) => p.id)).toEqual([13]);
	});

	it('manual mode returns the latest point', async () => {
		s = await startServer(() => ({ json: { id: 5, timestamp: minutesAgo(1) } }));
		const events = await poller({ event: 'locationUpdated' }, {}, 'manual')();
		expect(events[0]).toMatchObject({ event: 'locationUpdated', id: 5 });
	});
});

describe('GeoPulse Trigger – No Location Data', () => {
	it('fires once while data is missing and again only after data resumed', async () => {
		let age = 10;
		s = await startServer(() => ({
			json: {
				hasGpsData: true,
				latestGpsPointAgeMinutes: age,
				latestGpsPointTimestamp: minutesAgo(age),
			},
		}));
		const state: IDataObject = {};
		const poll = poller({ event: 'noLocationData', noDataMinutes: 60 }, state);
		expect(await poll()).toEqual([]);

		age = 90;
		const events = await poll();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event: 'noLocationData',
			thresholdMinutes: 60,
			minutesWithoutData: 90,
		});
		expect(await poll()).toEqual([]);
		expect(await poll()).toEqual([]);

		age = 1;
		expect(await poll()).toEqual([]);
		age = 120;
		expect(await poll()).toHaveLength(1);
	});

	it('does not fire on the first run even if data is already missing', async () => {
		s = await startServer(() => ({ json: { hasGpsData: false } }));
		const state: IDataObject = {};
		const poll = poller({ event: 'noLocationData', noDataMinutes: 5 }, state);
		expect(await poll()).toEqual([]);
		expect(await poll()).toEqual([]);
		expect(state.alerted).toBe(true);
	});

	it('manual mode returns the current freshness data', async () => {
		s = await startServer(() => ({ json: { hasGpsData: true, latestGpsPointAgeMinutes: 3 } }));
		const events = await poller({ event: 'noLocationData', noDataMinutes: 60 }, {}, 'manual')();
		expect(events[0]).toMatchObject({ event: 'noLocationData', minutesWithoutData: 3 });
	});
});
