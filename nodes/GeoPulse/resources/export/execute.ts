import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';

import { getOptions, readPeriod, resolveTimeZone } from '../../shared/params';
import { safeFileName } from '../../shared/security';
import { geoPulseApiRequest, geoPulseRequest } from '../../shared/transport';
import { checkSeconds, objectToItem } from '../../shared/utils';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXTENSIONS: Record<string, string> = {
	geopulse: 'zip',
	gpx: 'gpx',
	owntracks: 'json',
	geojson: 'geojson',
	csv: 'csv',
};

/** MIME types GeoPulse uses for exports; anything else is stored as application/octet-stream. */
const MIME_BY_EXTENSION: Record<string, string> = {
	zip: 'application/zip',
	gpx: 'application/gpx+xml',
	json: 'application/json',
	geojson: 'application/geo+json',
	csv: 'text/csv',
};

/** Keeps a server file name only with a known export extension, never e.g. .html or .svg. */
export function exportFileInfo(
	headerName: string | undefined,
	contentType: string | undefined,
	fallback: string,
): { fileName: string; mimeType: string } {
	let fileName = safeFileName(headerName, fallback);
	let extension = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
	if (!(extension in MIME_BY_EXTENSION)) {
		fileName = fallback;
		extension = fallback.split('.').pop()!.toLowerCase();
	}
	const declared = (contentType ?? '').split(';')[0].trim().toLowerCase();
	const allowed = new Set([...Object.values(MIME_BY_EXTENSION), 'application/octet-stream']);
	const mimeType = allowed.has(declared)
		? declared
		: (MIME_BY_EXTENSION[extension] ?? 'application/octet-stream');
	return { fileName, mimeType };
}

/** Validates the binary property name (no prototype keys, simple characters only). */
export function checkBinaryPropertyName(value: unknown): string {
	const name = String(value ?? '').trim() || 'data';
	if (
		['__proto__', 'constructor', 'prototype'].includes(name) ||
		!/^[A-Za-z0-9_.-]{1,100}$/.test(name)
	) {
		throw new Error(`"${name}" is not a valid binary property name`);
	}
	return name;
}

function checkJobId(value: unknown): string {
	const id = String(value ?? '').trim();
	if (!UUID_PATTERN.test(id))
		throw new Error('Export Job ID must be a UUID returned by Create Export');
	return id;
}

function fileNameFromHeader(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
	if (star) {
		try {
			return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
		} catch {
			return undefined;
		}
	}
	const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
	return plain ? plain[1].trim() : undefined;
}

async function download(
	ctx: IExecuteFunctions,
	jobId: string,
	i: number,
	job?: IDataObject,
): Promise<INodeExecutionData[]> {
	const binaryPropertyName = checkBinaryPropertyName(
		ctx.getNodeParameter('binaryPropertyName', i, 'data'),
	);
	const response = await geoPulseRequest(ctx, {
		method: 'GET',
		path: `/api/v1/exports/${jobId}/content`,
		binary: true,
	});
	const buffer = response.body as Buffer;
	const format = typeof job?.format === 'string' ? job.format : undefined;
	const fallback = `geopulse-export-${jobId}.${(format && EXTENSIONS[format]) ?? 'bin'}`;
	const { fileName, mimeType } = exportFileInfo(
		fileNameFromHeader(response.headers['content-disposition']),
		response.headers['content-type'],
		fallback,
	);
	const binary = await ctx.helpers.prepareBinaryData(buffer, fileName, mimeType);
	const binaryData: Record<string, typeof binary> = {};
	Object.defineProperty(binaryData, binaryPropertyName, {
		value: binary,
		enumerable: true,
		writable: true,
		configurable: true,
	});
	return [
		{
			json: { ...(job ?? { exportJobId: jobId }), fileName, fileSizeBytes: buffer.length },
			binary: binaryData,
			pairedItem: { item: i },
		},
	];
}

async function getJob(ctx: IExecuteFunctions, jobId: string): Promise<IDataObject> {
	return ((await geoPulseApiRequest(ctx, 'GET', `/api/v1/exports/${jobId}`)) ?? {}) as IDataObject;
}

export async function executeExport(
	this: IExecuteFunctions,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	if (operation === 'getStatus') {
		const jobId = checkJobId(this.getNodeParameter('exportJobId', i));
		return objectToItem(await getJob(this, jobId), i);
	}

	if (operation === 'download') {
		const jobId = checkJobId(this.getNodeParameter('exportJobId', i));
		return await download(this, jobId, i);
	}

	if (operation !== 'create') throw new Error(`Unsupported operation "${operation}" for Export`);

	const options = getOptions(this, i);
	const timeZone = resolveTimeZone(this, options.timeZone);
	const { from, to } = readPeriod(this, i, timeZone, true);
	const format = this.getNodeParameter('format', i) as string;
	if (!(format in EXTENSIONS)) throw new Error(`Unsupported export format "${format}"`);
	const wait = this.getNodeParameter('waitForCompletion', i, false) as boolean;
	const interval = wait
		? checkSeconds(this.getNodeParameter('pollInterval', i, 5), 'Poll Interval')
		: 0;
	const timeout = wait ? checkSeconds(this.getNodeParameter('waitTimeout', i, 600), 'Timeout') : 0;

	const body: IDataObject = { format, startTime: from, endTime: to };
	if (format === 'geopulse') {
		const dataTypes = this.getNodeParameter('dataTypes', i, []) as string[];
		if (dataTypes.length) body.dataTypes = dataTypes;
	}
	if (format === 'gpx') body.gpxLayout = this.getNodeParameter('gpxLayout', i, 'single');
	if (format === 'owntracks')
		body.owntracksLayout = this.getNodeParameter('owntracksLayout', i, 'array');

	const created = ((await geoPulseApiRequest(this, 'POST', '/api/v1/exports', undefined, body)) ??
		{}) as IDataObject;
	if (!wait) return objectToItem(created, i);

	const jobId = checkJobId(created.exportJobId);
	const deadline = Date.now() + timeout * 1000;
	let job = created;
	for (;;) {
		const status = String(job.status ?? '').toLowerCase();
		if (status === 'completed') break;
		if (status === 'failed') {
			const error = (job.error ?? {}) as IDataObject;
			throw new Error(
				`Export failed${error.fallback ? `: ${String(error.fallback).slice(0, 500)}` : ''} (job ${jobId})`,
			);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Export did not finish within ${timeout} seconds (job ${jobId}, status ${status || 'unknown'}). Use Get Export Status / Download Export later.`,
			);
		}
		await sleep(Math.min(interval * 1000, remaining));
		job = await getJob(this, jobId);
	}

	const shouldDownload = this.getNodeParameter('download', i, true) as boolean;
	if (!shouldDownload) return objectToItem(job, i);
	return await download(this, jobId, i, job);
}
