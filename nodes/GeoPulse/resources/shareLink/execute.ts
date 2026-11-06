import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { optionalUtcIso, toUtcIso } from '../../shared/dates';
import { resolveTimeZone } from '../../shared/params';
import { stripPasswords } from '../../shared/security';
import { geoPulseApiRequest, getBaseUrl } from '../../shared/transport';
import { asArray, listToItems, objectToItem } from '../../shared/utils';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public URL of a share link, as built by the GeoPulse web app. */
export function shareLinkUrl(link: IDataObject, baseUrl: string): string | undefined {
	if (typeof link.id !== 'string' || link.id === '') return undefined;
	const page = link.share_type === 'TIMELINE' ? 'shared-timeline' : 'shared';
	return `${baseUrl.replace(/\/+$/, '')}/${page}/${encodeURIComponent(link.id)}`;
}

function shareBaseUrl(list: IDataObject, fallback: string): string {
	const configured = typeof list.base_url === 'string' ? list.base_url.trim() : '';
	return /^https?:\/\//i.test(configured) ? configured : fallback;
}

/** Removes any field that could carry a password, at any depth, whatever the server sends. */
function withoutSecrets(link: IDataObject): IDataObject {
	return stripPasswords(link);
}

export async function executeShareLink(
	this: IExecuteFunctions,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	if (operation === 'getAll') {
		const baseUrl = await getBaseUrl(this);
		const list = ((await geoPulseApiRequest(this, 'GET', '/api/v1/share-links')) ??
			{}) as IDataObject;
		const base = shareBaseUrl(list, baseUrl);
		const links = asArray(list.links).map((link) => ({
			...withoutSecrets(link),
			url: shareLinkUrl(link, base),
		}));
		const split = this.getNodeParameter('splitIntoItems', i, true) as boolean;
		return listToItems(links, split, i);
	}

	if (operation === 'delete') {
		const id = String(this.getNodeParameter('shareLinkId', i) ?? '').trim();
		if (!UUID_PATTERN.test(id)) throw new Error('Share Link ID must be a UUID');
		await geoPulseApiRequest(this, 'DELETE', `/api/v1/share-links/${id}`);
		return objectToItem({ id, deleted: true }, i);
	}

	if (operation !== 'create')
		throw new Error(`Unsupported operation "${operation}" for Share Link`);

	const fields = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
	const timeZone = resolveTimeZone(this, fields.timeZone);
	const name = String(this.getNodeParameter('name', i) ?? '').trim();
	if (name === '') throw new Error('Name is required');
	const shareType = this.getNodeParameter('shareType', i) as string;
	const password = typeof fields.password === 'string' ? fields.password : '';

	const body: IDataObject = { name, share_type: shareType };
	const expiresAt = optionalUtcIso(fields.expiresAt, timeZone, 'Expires At');
	if (expiresAt) {
		if (Date.parse(expiresAt) <= Date.now()) throw new Error('Expires At must be in the future');
		body.expires_at = expiresAt;
	}
	if (password !== '') body.password = password;

	if (shareType === 'TIMELINE') {
		const start = toUtcIso(this.getNodeParameter('startDate', i), timeZone, 'Start Date');
		const end = toUtcIso(this.getNodeParameter('endDate', i), timeZone, 'End Date');
		if (Date.parse(start) > Date.parse(end)) throw new Error('Start Date must be before End Date');
		body.start_date = start;
		body.end_date = end;
		for (const [field, key] of [
			['showCurrentLocation', 'show_current_location'],
			['showNotes', 'show_notes'],
			['showPhotos', 'show_photos'],
		]) {
			if (typeof fields[field] === 'boolean') body[key] = fields[field];
		}
	} else {
		if (typeof fields.showHistory === 'boolean') body.show_history = fields.showHistory;
		if (fields.historyHours !== undefined) {
			const hours = Number(fields.historyHours);
			if (!Number.isInteger(hours) || hours < 1)
				throw new Error('History Hours must be a positive integer');
			body.history_hours = hours;
		}
	}

	const secrets = password !== '' ? [password] : [];
	const created = ((await geoPulseApiRequest(
		this,
		'POST',
		'/api/v1/share-links',
		undefined,
		body,
		secrets,
	)) ?? {}) as IDataObject;

	let base = await getBaseUrl(this);
	try {
		const list = ((await geoPulseApiRequest(this, 'GET', '/api/v1/share-links')) ??
			{}) as IDataObject;
		base = shareBaseUrl(list, base);
	} catch {
		// The configured share base URL is optional: fall back to the credential Base URL.
	}
	const link = withoutSecrets({ share_type: shareType, ...created });
	return objectToItem({ ...link, url: shareLinkUrl(link, base) }, i);
}
