import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';

import { getOptions, readPeriod, resolveTimeZone } from '../../shared/params';
import { geoPulseApiRequest } from '../../shared/transport';
import type { TimelineItemType } from '../../shared/utils';
import { checkSeconds, listToItems, normalizeTimeline, objectToItem } from '../../shared/utils';

const TYPE_BY_OPERATION: Record<string, TimelineItemType | undefined> = {
	getStays: 'stay',
	getTrips: 'trip',
	getDataGaps: 'dataGap',
	getTimeline: undefined,
};

async function regenerate(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const wait = this.getNodeParameter('waitForCompletion', i, false) as boolean;
	const interval = wait
		? checkSeconds(this.getNodeParameter('pollInterval', i, 5), 'Poll Interval')
		: 0;
	const timeout = wait ? checkSeconds(this.getNodeParameter('waitTimeout', i, 600), 'Timeout') : 0;

	const started = (await geoPulseApiRequest(this, 'POST', '/api/v1/timeline/jobs')) as IDataObject;
	const jobId = typeof started?.jobId === 'string' ? started.jobId : undefined;
	if (!jobId) throw new Error('GeoPulse did not return a timeline job ID');
	if (!wait) return objectToItem({ jobId, status: 'QUEUED' }, i);

	const deadline = Date.now() + timeout * 1000;
	for (;;) {
		const job = (await geoPulseApiRequest(
			this,
			'GET',
			`/api/v1/timeline/jobs/${encodeURIComponent(jobId)}`,
		)) as IDataObject;
		const status = String(job?.status ?? '');
		if (status === 'COMPLETED') return objectToItem({ ...job, jobId }, i);
		if (status === 'FAILED') {
			throw new Error(
				`Timeline regeneration failed${job?.errorMessage ? `: ${String(job.errorMessage)}` : ''} (job ${jobId})`,
			);
		}
		if (job?.terminal === true) return objectToItem({ ...job, jobId }, i);
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Timeline regeneration did not finish within ${timeout} seconds (job ${jobId}, status ${status || 'unknown'}). It keeps running in GeoPulse.`,
			);
		}
		await sleep(Math.min(interval * 1000, remaining));
	}
}

export async function executeTimeline(
	this: IExecuteFunctions,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	if (operation === 'regenerate') return await regenerate.call(this, i);

	const options = getOptions(this, i);
	const timeZone = resolveTimeZone(this, options.timeZone);
	const { from, to } = readPeriod(this, i, timeZone, false);

	if (operation === 'getStatistics') {
		const stats = (await geoPulseApiRequest(this, 'GET', '/api/v1/statistics', {
			from,
			to,
		})) as IDataObject;
		return objectToItem(stats ?? {}, i);
	}

	if (operation in TYPE_BY_OPERATION) {
		const timeline = await geoPulseApiRequest(this, 'GET', '/api/v1/timeline', {
			from,
			to,
			includeLocationTimezones: options.includeLocationTimezones === true ? true : undefined,
		});
		const type = TYPE_BY_OPERATION[operation];
		const items = normalizeTimeline(timeline).filter((item) => !type || item.type === type);
		const split = this.getNodeParameter('splitIntoItems', i, true) as boolean;
		return listToItems(items, split, i);
	}

	throw new Error(`Unsupported operation "${operation}" for Timeline`);
}
