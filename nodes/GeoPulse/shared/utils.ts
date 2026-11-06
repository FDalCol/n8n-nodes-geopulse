import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

export type TimelineItemType = 'stay' | 'trip' | 'dataGap';

export interface TimelineItem extends IDataObject {
	type: TimelineItemType;
	startTime: string;
	endTime: string | null;
}

/** Wraps a list as output items: one item per element, or one item `{ items, count }`. */
export function listToItems(
	list: IDataObject[],
	splitIntoItems: boolean,
	itemIndex: number,
): INodeExecutionData[] {
	if (splitIntoItems) {
		return list.map((json) => ({ json, pairedItem: { item: itemIndex } }));
	}
	return [{ json: { items: list, count: list.length }, pairedItem: { item: itemIndex } }];
}

export function objectToItem(json: IDataObject, itemIndex: number): INodeExecutionData[] {
	return [{ json, pairedItem: { item: itemIndex } }];
}

export function asArray(value: unknown): IDataObject[] {
	return Array.isArray(value) ? (value as IDataObject[]) : [];
}

function addSeconds(iso: unknown, seconds: unknown): string | null {
	if (typeof iso !== 'string') return null;
	const start = Date.parse(iso);
	const duration = Number(seconds);
	if (!Number.isFinite(start) || !Number.isFinite(duration)) return null;
	return new Date(start + duration * 1000).toISOString();
}

/**
 * Merges the stays, trips and data gaps of GET /api/v1/timeline into one chronological list.
 * Each element keeps GeoPulse's fields and gets `type`, `startTime` and `endTime`
 * (stay and trip durations are in seconds).
 */
export function normalizeTimeline(timeline: unknown): TimelineItem[] {
	const data = (timeline ?? {}) as IDataObject;
	const items: TimelineItem[] = [];
	for (const stay of asArray(data.stays)) {
		items.push({
			type: 'stay',
			startTime: String(stay.timestamp ?? ''),
			endTime: addSeconds(stay.timestamp, stay.stayDuration),
			...stay,
		});
	}
	for (const trip of asArray(data.trips)) {
		items.push({
			type: 'trip',
			startTime: String(trip.timestamp ?? ''),
			endTime: addSeconds(trip.timestamp, trip.tripDuration),
			...trip,
		});
	}
	for (const gap of asArray(data.dataGaps)) {
		items.push({
			type: 'dataGap',
			startTime: String(gap.startTime ?? ''),
			endTime: typeof gap.endTime === 'string' ? gap.endTime : null,
			...gap,
		});
	}
	return items.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

/** Great-circle distance in meters. */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Parses JSON text; returns `undefined` when it is not valid JSON. */
export function parseJsonText(text: string): { value: unknown } | undefined {
	try {
		return { value: JSON.parse(text) };
	} catch {
		return undefined;
	}
}

export function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** Validates a polling/wait duration in seconds: between 1 s and 24 h, also when set by expression. */
export function checkSeconds(value: unknown, field: string): number {
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) {
		throw new Error(`${field} must be between 1 and 86400 seconds (24 hours)`);
	}
	return seconds;
}
