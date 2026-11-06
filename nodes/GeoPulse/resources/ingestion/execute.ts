import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { toUtcIso } from '../../shared/dates';
import { getOptions, resolveTimeZone } from '../../shared/params';
import { INGEST_PATH } from '../../shared/security';
import { geoPulseApiRequest } from '../../shared/transport';
import { objectToItem, parseJsonText } from '../../shared/utils';

/** Maximum points per request accepted by POST /api/v1/gps/ingest/home-assistant/batch. */
export const INGEST_BATCH_SIZE = 1000;

interface HomeAssistantPoint extends IDataObject {
	device_id: string;
	timestamp: string;
	location: IDataObject;
	battery?: IDataObject;
}

function optionalNumber(value: unknown, field: string, label: string): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const number = Number(value);
	if (!Number.isFinite(number)) throw new Error(`${label}: ${field} must be a number`);
	return number;
}

/** Converts one input point to the Home Assistant ingestion format (speed in m/s, battery 0-100). */
export function toHomeAssistantPoint(
	point: IDataObject,
	timeZone: string,
	label: string,
	defaultTimestamp?: string,
): HomeAssistantPoint {
	const latitude = optionalNumber(point.latitude ?? point.lat, 'latitude', label);
	const longitude = optionalNumber(point.longitude ?? point.lng ?? point.lon, 'longitude', label);
	if (latitude === undefined || latitude < -90 || latitude > 90) {
		throw new Error(`${label}: latitude is required and must be between -90 and 90`);
	}
	if (longitude === undefined || longitude < -180 || longitude > 180) {
		throw new Error(`${label}: longitude is required and must be between -180 and 180`);
	}
	const rawTimestamp = point.timestamp ?? point.time ?? defaultTimestamp;
	if (rawTimestamp === undefined || rawTimestamp === null || rawTimestamp === '') {
		throw new Error(`${label}: timestamp is required`);
	}
	const timestamp = toUtcIso(rawTimestamp, timeZone, `${label}: timestamp`);

	const location: IDataObject = { latitude, longitude };
	const accuracy = optionalNumber(point.accuracy, 'accuracy', label);
	if (accuracy !== undefined) {
		if (accuracy < 0) throw new Error(`${label}: accuracy must not be negative`);
		location.accuracy = accuracy;
	}
	const altitude = optionalNumber(point.altitude, 'altitude', label);
	if (altitude !== undefined) location.altitude = altitude;
	const speed = optionalNumber(point.speed, 'speed', label);
	if (speed !== undefined) {
		if (speed < 0) throw new Error(`${label}: speed must not be negative`);
		location.speed = speed;
	}

	const result: HomeAssistantPoint = {
		device_id:
			typeof (point.deviceId ?? point.device_id) === 'string' &&
			String(point.deviceId ?? point.device_id).trim()
				? String(point.deviceId ?? point.device_id).trim()
				: 'n8n',
		timestamp,
		location,
	};
	const battery = optionalNumber(point.battery, 'battery', label);
	if (battery !== undefined) {
		if (battery < 0 || battery > 100)
			throw new Error(`${label}: battery must be between 0 and 100`);
		result.battery = { level: Math.round(battery) };
	}
	return result;
}

function readPoints(ctx: IExecuteFunctions, i: number): IDataObject[] {
	const raw = ctx.getNodeParameter('points', i);
	let value: unknown = raw;
	if (typeof raw === 'string') {
		const parsed = parseJsonText(raw);
		if (!parsed) throw new Error('Points is not valid JSON: enter an array of points');
		value = parsed.value;
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) value = [value];
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error('Points must be a non-empty array');
	}
	return value.map((point, index) => {
		if (!point || typeof point !== 'object' || Array.isArray(point)) {
			throw new Error(`Point ${index + 1} is not an object`);
		}
		return point as IDataObject;
	});
}

export async function executeIngestion(
	this: IExecuteFunctions,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	if (operation !== 'sendLocation')
		throw new Error(`Unsupported operation "${operation}" for Ingestion`);

	const options = getOptions(this, i);
	const timeZone = resolveTimeZone(this, options.timeZone);
	const mode = this.getNodeParameter('inputMode', i, 'single') as string;

	let points: HomeAssistantPoint[];
	if (mode === 'multiple') {
		points = readPoints(this, i).map((point, index) =>
			toHomeAssistantPoint(point, timeZone, `Point ${index + 1}`),
		);
	} else {
		const additional = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
		const timestamp = this.getNodeParameter('timestamp', i, '');
		points = [
			toHomeAssistantPoint(
				{
					...additional,
					latitude: this.getNodeParameter('latitude', i) as number,
					longitude: this.getNodeParameter('longitude', i) as number,
					timestamp: timestamp === '' ? undefined : (timestamp as string),
				},
				timeZone,
				'Point',
				new Date().toISOString(),
			),
		];
	}

	const totals = { accepted: 0, saved: 0, duplicate: 0, filtered: 0 };
	let requests = 0;
	for (let start = 0; start < points.length; start += INGEST_BATCH_SIZE) {
		const batch = points.slice(start, start + INGEST_BATCH_SIZE);
		const summary = (await geoPulseApiRequest(
			this,
			'POST',
			INGEST_PATH,
			undefined,
			batch,
		)) as IDataObject;
		requests++;
		for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
			const value = Number(summary?.[key]);
			if (Number.isFinite(value)) totals[key] += value;
		}
	}

	const timestamps = points.map((point) => point.timestamp).sort();
	return objectToItem(
		{
			sent: points.length,
			...totals,
			requests,
			firstTimestamp: timestamps[0],
			lastTimestamp: timestamps[timestamps.length - 1],
		},
		i,
	);
}
