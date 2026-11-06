import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { redact } from '../GeoPulse/shared/security';
import {
	geoPulseApiRequest,
	geoPulsePaginate,
	getCredentialSecrets,
} from '../GeoPulse/shared/transport';
import type { TimelineItem } from '../GeoPulse/shared/utils';
import { distanceMeters, isFiniteNumber, normalizeTimeline } from '../GeoPulse/shared/utils';

type GeoPulseEvent =
	| 'arrivedAtPlace'
	| 'leftPlace'
	| 'newTrip'
	| 'locationUpdated'
	| 'noLocationData';

const TIMELINE_EVENTS: GeoPulseEvent[] = ['arrivedAtPlace', 'leftPlace', 'newTrip'];

/** Two stays/trips are the same when they start within this time and distance (timeline regeneration). */
const SAME_START_MS = 10 * 60_000;
const SAME_PLACE_METERS = 250;
const MAX_REMEMBERED = 500;
const MAX_POINTS_PER_POLL = 5000;
/** Bounds the per-poll work and the static data when the server returns very large lists. */
const MAX_CANDIDATES = 1000;
const MAX_IDS_AT_WATERMARK = 1000;

interface SeenRecord {
	key: string;
	start: number;
	lat?: number;
	lng?: number;
}

interface TriggerState extends IDataObject {
	event?: string;
	initialized?: boolean;
	seen?: SeenRecord[];
	watermark?: number | null;
	pointWatermark?: string | null;
	pointIdsAtWatermark?: number[];
	alerted?: boolean;
}

interface PlaceFilter {
	mode: 'none' | 'radius' | 'placeName';
	latitude?: number;
	longitude?: number;
	radius?: number;
	placeName?: string;
}

interface Candidate {
	record: SeenRecord;
	item: TimelineItem;
}

function point(lat: unknown, lng: unknown): { lat: number; lng: number } | undefined {
	return isFiniteNumber(lat) && isFiniteNumber(lng) ? { lat, lng } : undefined;
}

function itemCoordinates(item: IDataObject): Array<{ lat: number; lng: number }> {
	const coords = (item.coordinates ?? {}) as IDataObject;
	return [
		point(item.latitude, item.longitude),
		point(item.endLatitude, item.endLongitude),
		point(coords.lat, coords.lng),
	].filter((value): value is { lat: number; lng: number } => value !== undefined);
}

function matchesFilter(item: IDataObject, filter: PlaceFilter): boolean {
	if (filter.mode === 'radius') {
		return itemCoordinates(item).some(
			(c) => distanceMeters(c.lat, c.lng, filter.latitude!, filter.longitude!) <= filter.radius!,
		);
	}
	if (filter.mode === 'placeName') {
		const needle = (filter.placeName ?? '').toLowerCase();
		return [item.locationName, item.visitName].some(
			(name) => typeof name === 'string' && name.toLowerCase().includes(needle),
		);
	}
	return true;
}

function isSame(a: SeenRecord, b: SeenRecord): boolean {
	if (a.key === b.key) return true;
	if (Math.abs(a.start - b.start) > SAME_START_MS) return false;
	if (a.lat === undefined || a.lng === undefined || b.lat === undefined || b.lng === undefined) {
		return false;
	}
	return distanceMeters(a.lat, a.lng, b.lat, b.lng) <= SAME_PLACE_METERS;
}

/** Stays (arrived), ended stays (left) or completed trips (new trip) of a timeline. */
function timelineCandidates(items: TimelineItem[], event: GeoPulseEvent): Candidate[] {
	const out: Candidate[] = [];
	// Latest start among the following items, computed once (linear, not quadratic).
	const latestAfter: number[] = new Array(items.length).fill(-Infinity);
	for (let index = items.length - 2; index >= 0; index--) {
		const next = Date.parse(items[index + 1].startTime);
		latestAfter[index] = Math.max(latestAfter[index + 1], Number.isFinite(next) ? next : -Infinity);
	}
	items.forEach((item, index) => {
		const start = Date.parse(item.startTime);
		if (!Number.isFinite(start)) return;
		const hasNext = latestAfter[index] >= start;
		const wanted =
			(event === 'arrivedAtPlace' && item.type === 'stay') ||
			(event === 'leftPlace' && item.type === 'stay' && hasNext) ||
			(event === 'newTrip' && item.type === 'trip' && hasNext);
		if (!wanted) return;
		const coords = point(item.latitude, item.longitude);
		out.push({
			record: { key: `${item.type}:${item.startTime}`, start, lat: coords?.lat, lng: coords?.lng },
			item,
		});
	});
	return out;
}

export class GeoPulseTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GeoPulse Trigger',
		name: 'geoPulseTrigger',
		icon: { light: 'file:geopulse.svg', dark: 'file:geopulse.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{ $parameter["event"] }}',
		description:
			'Starts the workflow on GeoPulse events: arrival at or departure from a place, new trips, new GPS points or missing location data',
		defaults: {
			name: 'GeoPulse Trigger',
		},
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'geoPulseApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Arrived At Place',
						value: 'arrivedAtPlace',
						description:
							'A new stay started. Fires only once GeoPulse recognizes the stay, i.e. after the minimum stay duration set in its timeline settings, and after the timeline update (every few minutes).',
					},
					{
						name: 'Left Place',
						value: 'leftPlace',
						description:
							'A stay ended. Fires only when the next timeline element (trip or stay) starts in GeoPulse, so with some delay after leaving.',
					},
					{
						name: 'Location Updated',
						value: 'locationUpdated',
						description: 'A new GPS point was received',
					},
					{
						name: 'New Trip',
						value: 'newTrip',
						description:
							'A trip was completed. Fires only when the next timeline element (usually a stay) starts in GeoPulse, so with some delay after arriving.',
					},
					{
						name: 'No Location Data',
						value: 'noLocationData',
						description:
							'No GPS point for more than N minutes. Fires once, then again only after data has resumed and stopped again.',
					},
				],
				default: 'arrivedAtPlace',
			},
			{
				displayName:
					'Arrived At Place fires after GeoPulse recognizes the stay (minimum stay duration); Left Place and New Trip fire when the next timeline element starts. Expect a delay of several minutes.',
				name: 'timelineDelayNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { event: ['arrivedAtPlace', 'leftPlace', 'newTrip'] } },
			},
			{
				displayName: 'Minutes Without Data',
				name: 'noDataMinutes',
				type: 'number',
				default: 60,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { event: ['noLocationData'] } },
				description: 'Fire when the last GPS point is older than this many minutes',
			},
			{
				displayName: 'Place Filter',
				name: 'placeFilter',
				type: 'options',
				options: [
					{ name: 'None', value: 'none' },
					{
						name: 'Place Name',
						value: 'placeName',
						description: 'Stays whose GeoPulse place name contains the given text',
					},
					{
						name: 'Radius',
						value: 'radius',
						description: 'Within a distance from a point',
					},
				],
				default: 'none',
				displayOptions: { show: { event: ['arrivedAtPlace', 'leftPlace'] } },
				description: 'Only fire for a place',
			},
			{
				displayName: 'Place Filter',
				name: 'placeFilter',
				type: 'options',
				options: [
					{ name: 'None', value: 'none' },
					{
						name: 'Radius',
						value: 'radius',
						description:
							'Within a distance from a point (for trips: start or end point; GeoPulse has no place names for trips and points)',
					},
				],
				default: 'none',
				displayOptions: { show: { event: ['newTrip', 'locationUpdated'] } },
				description: 'Only fire near a place',
			},
			{
				displayName: 'Center Latitude',
				name: 'latitude',
				type: 'number',
				default: 0,
				typeOptions: { minValue: -90, maxValue: 90, numberPrecision: 7 },
				displayOptions: {
					show: {
						event: ['arrivedAtPlace', 'leftPlace', 'newTrip', 'locationUpdated'],
						placeFilter: ['radius'],
					},
				},
			},
			{
				displayName: 'Center Longitude',
				name: 'longitude',
				type: 'number',
				default: 0,
				typeOptions: { minValue: -180, maxValue: 180, numberPrecision: 7 },
				displayOptions: {
					show: {
						event: ['arrivedAtPlace', 'leftPlace', 'newTrip', 'locationUpdated'],
						placeFilter: ['radius'],
					},
				},
			},
			{
				displayName: 'Radius (Meters)',
				name: 'radius',
				type: 'number',
				default: 200,
				typeOptions: { minValue: 1 },
				displayOptions: {
					show: {
						event: ['arrivedAtPlace', 'leftPlace', 'newTrip', 'locationUpdated'],
						placeFilter: ['radius'],
					},
				},
			},
			{
				displayName: 'Place Name',
				name: 'placeName',
				type: 'string',
				default: '',
				placeholder: 'Home',
				displayOptions: {
					show: { event: ['arrivedAtPlace', 'leftPlace'], placeFilter: ['placeName'] },
				},
				description:
					'Text contained in the place name of the stay (favorite name or geocoded address), case-insensitive',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { event: ['arrivedAtPlace', 'leftPlace', 'newTrip'] } },
				options: [
					{
						displayName: 'Lookback (Hours)',
						name: 'lookbackHours',
						type: 'number',
						default: 24,
						typeOptions: { minValue: 1, maxValue: 720 },
						description:
							'How much of the recent timeline to read at each poll, from 1 to 720 hours',
					},
				],
			},
		],
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const event = this.getNodeParameter('event') as GeoPulseEvent;
		const manual = this.getMode() === 'manual';
		const state = this.getWorkflowStaticData('node') as TriggerState;
		const secrets = await getCredentialSecrets(this);

		const fail = (message: string) =>
			new NodeOperationError(this.getNode(), redact(message, secrets));

		let filter: PlaceFilter = { mode: 'none' };
		if (event !== 'noLocationData') {
			const mode = this.getNodeParameter('placeFilter', 'none') as PlaceFilter['mode'];
			if (mode === 'radius') {
				const latitude = Number(this.getNodeParameter('latitude', 0));
				const longitude = Number(this.getNodeParameter('longitude', 0));
				const radius = Number(this.getNodeParameter('radius', 200));
				if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
					throw fail('Center Latitude must be between -90 and 90');
				}
				if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
					throw fail('Center Longitude must be between -180 and 180');
				}
				if (!Number.isFinite(radius) || radius <= 0) throw fail('Radius must be greater than 0');
				filter = { mode, latitude, longitude, radius };
			} else if (mode === 'placeName') {
				const placeName = String(this.getNodeParameter('placeName', '')).trim();
				if (placeName === '') throw fail('Place Name is required for the Place Name filter');
				filter = { mode, placeName };
			}
		}

		if (!manual && state.event !== event) {
			for (const key of Object.keys(state)) delete state[key];
			state.event = event;
		}

		const emit = (records: IDataObject[]): INodeExecutionData[][] | null =>
			records.length ? [records.map((json) => ({ json: { event, ...json } }))] : null;

		if (TIMELINE_EVENTS.includes(event)) {
			const options = this.getNodeParameter('options', {}) as IDataObject;
			const lookbackHours = Number(options.lookbackHours ?? 24);
			if (!Number.isFinite(lookbackHours) || lookbackHours < 1 || lookbackHours > 720) {
				throw fail('Lookback must be between 1 and 720 hours');
			}
			const now = Date.now();
			const timeline = await geoPulseApiRequest(this, 'GET', '/api/v1/timeline', {
				from: new Date(now - lookbackHours * 3_600_000).toISOString(),
				to: new Date(now).toISOString(),
			});
			const candidates = timelineCandidates(normalizeTimeline(timeline), event).slice(
				-MAX_CANDIDATES,
			);

			if (manual) {
				const matching = candidates.filter((c) => matchesFilter(c.item, filter));
				const latest = (matching.length ? matching : candidates).slice(-1);
				return emit(latest.map((c) => c.item));
			}

			const seen = Array.isArray(state.seen) ? state.seen : [];
			if (!state.initialized) {
				state.seen = candidates.map((c) => c.record).slice(-MAX_REMEMBERED);
				state.watermark = candidates.length
					? candidates.reduce((max, c) => Math.max(max, c.record.start), -Infinity)
					: null;
				state.initialized = true;
				return null;
			}

			const watermark = typeof state.watermark === 'number' ? state.watermark : -Infinity;
			const out: IDataObject[] = [];
			let newWatermark = watermark;
			for (const candidate of candidates) {
				const known = seen.some((record) => isSame(record, candidate.record));
				if (!known) seen.push(candidate.record);
				if (known || candidate.record.start <= watermark) continue;
				newWatermark = Math.max(newWatermark, candidate.record.start);
				if (matchesFilter(candidate.item, filter)) out.push(candidate.item);
			}
			const oldest = now - (lookbackHours + 24) * 3_600_000;
			state.seen = seen.filter((record) => record.start >= oldest).slice(-MAX_REMEMBERED);
			state.watermark = Number.isFinite(newWatermark) ? newWatermark : (state.watermark ?? null);
			return emit(out);
		}

		if (event === 'locationUpdated') {
			if (manual || !state.initialized) {
				const latest = (await geoPulseApiRequest(this, 'GET', '/api/v1/gps/points/latest')) as
					| IDataObject
					| undefined;
				const hasPoint =
					latest && typeof latest === 'object' && typeof latest.timestamp === 'string';
				if (manual) return hasPoint ? emit([latest]) : null;
				state.pointWatermark = hasPoint ? (latest.timestamp as string) : null;
				state.pointIdsAtWatermark = hasPoint && isFiniteNumber(latest.id) ? [latest.id] : [];
				state.initialized = true;
				return null;
			}

			const watermark = typeof state.pointWatermark === 'string' ? state.pointWatermark : undefined;
			const knownIds = new Set(
				Array.isArray(state.pointIdsAtWatermark) ? state.pointIdsAtWatermark : [],
			);
			const points = await geoPulsePaginate(
				this,
				'/api/v1/gps/points',
				{ from: watermark, sortBy: 'timestamp', sortDirection: 'asc' },
				{ returnAll: false, limit: MAX_POINTS_PER_POLL, maxPageSize: 1000 },
			);
			const watermarkMs = watermark ? Date.parse(watermark) : -Infinity;
			const fresh = points.filter((p) => {
				const ts = Date.parse(String(p.timestamp));
				if (!Number.isFinite(ts)) return false;
				if (ts > watermarkMs) return true;
				return ts === watermarkMs && !(isFiniteNumber(p.id) && knownIds.has(p.id));
			});
			if (fresh.length) {
				const maxMs = fresh.reduce(
					(max, p) => Math.max(max, Date.parse(String(p.timestamp))),
					-Infinity,
				);
				const atMax = fresh.filter((p) => Date.parse(String(p.timestamp)) === maxMs);
				state.pointWatermark = String(atMax[0].timestamp);
				const ids = atMax.map((p) => p.id).filter(isFiniteNumber);
				const merged = maxMs === watermarkMs ? [...knownIds, ...ids] : ids;
				state.pointIdsAtWatermark = merged.slice(-MAX_IDS_AT_WATERMARK);
			}
			return emit(fresh.filter((p) => matchesFilter(p, filter)));
		}

		if (event === 'noLocationData') {
			const minutes = Number(this.getNodeParameter('noDataMinutes', 60));
			if (!Number.isFinite(minutes) || minutes < 1)
				throw fail('Minutes Without Data must be at least 1');
			const status = ((await geoPulseApiRequest(this, 'GET', '/api/v1/gps/points/status')) ??
				{}) as IDataObject;
			const lastTimestamp =
				typeof status.latestGpsPointTimestamp === 'string' ? status.latestGpsPointTimestamp : null;
			let ageMinutes: number | null = isFiniteNumber(status.latestGpsPointAgeMinutes)
				? status.latestGpsPointAgeMinutes
				: null;
			if (ageMinutes === null && lastTimestamp) {
				ageMinutes = Math.floor((Date.now() - Date.parse(lastTimestamp)) / 60_000);
			}
			const stale = status.hasGpsData === false || ageMinutes === null || ageMinutes > minutes;
			const payload: IDataObject = {
				thresholdMinutes: minutes,
				minutesWithoutData: ageMinutes,
				lastPointTimestamp: lastTimestamp,
				...status,
			};

			if (manual) return emit([payload]);
			if (!state.initialized) {
				state.alerted = stale;
				state.initialized = true;
				return null;
			}
			if (!stale) {
				state.alerted = false;
				return null;
			}
			if (state.alerted) return null;
			state.alerted = true;
			return emit([payload]);
		}

		throw fail(`Unsupported event "${String(event)}"`);
	}
}
