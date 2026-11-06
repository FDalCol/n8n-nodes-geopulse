import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { getOptions, readPeriod, resolveTimeZone } from '../../shared/params';
import { geoPulseApiRequest, geoPulsePaginate } from '../../shared/transport';
import { listToItems, objectToItem } from '../../shared/utils';

export async function executeLocation(
	this: IExecuteFunctions,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	if (operation === 'getLastLocation') {
		const point = (await geoPulseApiRequest(this, 'GET', '/api/v1/gps/points/latest')) as
			| IDataObject
			| undefined;
		if (!point || typeof point !== 'object' || Object.keys(point).length === 0) {
			return objectToItem({ found: false, message: 'No GPS points recorded yet' }, i);
		}
		return objectToItem({ found: true, ...point }, i);
	}

	if (operation === 'getCurrentStatus') {
		const status = (await geoPulseApiRequest(
			this,
			'GET',
			'/api/v1/users/me/status',
		)) as IDataObject;
		return objectToItem(status ?? {}, i);
	}

	if (operation === 'getPointPlace') {
		const pointId = Number(this.getNodeParameter('pointId', i));
		if (!Number.isInteger(pointId) || pointId < 1)
			throw new Error('Point ID must be a positive integer');
		const options = getOptions(this, i);
		const place = (await geoPulseApiRequest(this, 'GET', `/api/v1/gps/points/${pointId}/location`, {
			includeLocationTimezones: options.includeLocationTimezones === true ? true : undefined,
		})) as IDataObject;
		return objectToItem({ pointId, ...(place ?? {}) }, i);
	}

	const options = getOptions(this, i);
	const timeZone = resolveTimeZone(this, options.timeZone);
	const { from, to } = readPeriod(this, i, timeZone, false);

	if (operation === 'getPoints') {
		const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
		const limit = returnAll ? 0 : Number(this.getNodeParameter('limit', i, 50));
		const sourceTypes = Array.isArray(options.sourceTypes) ? (options.sourceTypes as string[]) : [];
		const points = await geoPulsePaginate(
			this,
			'/api/v1/gps/points',
			{
				from,
				to,
				sortBy: 'timestamp',
				sortDirection: options.sortDirection === 'asc' ? 'asc' : 'desc',
				sourceTypes: sourceTypes.length ? sourceTypes.join(',') : undefined,
				includeLocationTimezones: options.includeLocationTimezones === true ? true : undefined,
			},
			{ returnAll, limit, maxPageSize: 1000 },
		);
		const split = this.getNodeParameter('splitIntoItems', i, true) as boolean;
		return listToItems(points, split, i);
	}

	if (operation === 'getPath') {
		const path = (await geoPulseApiRequest(this, 'GET', '/api/v1/gps/points/path', {
			from,
			to,
			simplify: options.simplify === false ? false : undefined,
		})) as IDataObject;
		const result = path ?? {};
		return objectToItem(
			{
				...result,
				points: Array.isArray(result.points) ? result.points : [],
				segments: Array.isArray(result.segments) ? result.segments : [],
			},
			i,
		);
	}

	if (operation === 'getSummary') {
		const summary = (await geoPulseApiRequest(this, 'GET', '/api/v1/gps/points/summary', {
			from,
			to,
		})) as IDataObject;
		return objectToItem(summary ?? {}, i);
	}

	throw new Error(`Unsupported operation "${operation}" for Location`);
}
