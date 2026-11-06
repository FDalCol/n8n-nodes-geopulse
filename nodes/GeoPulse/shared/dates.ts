/**
 * Date handling without runtime dependencies. GeoPulse expects ISO-8601 instants (UTC); inputs
 * without an explicit offset are interpreted in the selected time zone.
 */

const ISO_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

export function isValidTimeZone(timeZone: string): boolean {
	if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone });
		return true;
	} catch {
		return false;
	}
}

/** Offset of `timeZone` from UTC at the instant `timestamp`, in milliseconds. */
function timeZoneOffsetMs(timestamp: number, timeZone: string): number {
	const seconds = Math.floor(timestamp / 1000) * 1000;
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(new Date(seconds));
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		get('hour') % 24,
		get('minute'),
		get('second'),
	);
	return asUtc - seconds;
}

/** Converts a wall-clock time in `timeZone` to a UTC timestamp. */
export function zonedTimeToUtc(localAsUtc: number, timeZone: string): number {
	const first = timeZoneOffsetMs(localAsUtc, timeZone);
	let utc = localAsUtc - first;
	const second = timeZoneOffsetMs(utc, timeZone);
	if (second !== first) utc = localAsUtc - second;
	return utc;
}

function parseOffset(offset: string): number {
	if (offset.toUpperCase() === 'Z') return 0;
	const sign = offset.startsWith('-') ? -1 : 1;
	const digits = offset.slice(1).replace(':', '');
	const hours = Number(digits.slice(0, 2));
	const minutes = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
	if (hours > 23 || minutes > 59) throw new Error('invalid offset');
	return sign * (hours * 60 + minutes) * 60_000;
}

function parseIsoString(value: string, timeZone: string): number {
	const match = ISO_PATTERN.exec(value.trim());
	if (!match) throw new Error('not ISO 8601');
	const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = '0', offset] = match;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	const hour = Number(h);
	const minute = Number(mi);
	const second = Number(s);
	const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
	const local = Date.UTC(year, month - 1, day, hour, minute, second, millis);
	const check = new Date(local);
	if (
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== day ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		throw new Error('out of range');
	}
	if (offset !== undefined) return local - parseOffset(offset);
	return zonedTimeToUtc(local, timeZone);
}

/**
 * Converts an n8n date (ISO string, Date, Luxon DateTime, epoch milliseconds) to an ISO-8601 UTC
 * instant. Values without an offset are read in `timeZone`.
 */
export function toUtcIso(value: unknown, timeZone: string, field: string): string {
	let timestamp = Number.NaN;
	try {
		if (value instanceof Date) {
			timestamp = value.getTime();
		} else if (typeof value === 'number') {
			timestamp = value;
		} else if (
			value !== null &&
			typeof value === 'object' &&
			typeof (value as { toISO?: unknown }).toISO === 'function'
		) {
			timestamp = parseIsoString(String((value as { toISO: () => string }).toISO()), timeZone);
		} else if (typeof value === 'string' && value.trim() !== '') {
			timestamp = parseIsoString(value, timeZone);
		}
	} catch {
		timestamp = Number.NaN;
	}
	if (!Number.isFinite(timestamp)) {
		throw new Error(
			`${field} is not a valid date: use an n8n date or ISO 8601, e.g. 2025-06-01T08:00:00Z or 2025-06-01 08:00`,
		);
	}
	return new Date(timestamp).toISOString();
}

/** Returns `toUtcIso(value)` or undefined when the value is empty. */
export function optionalUtcIso(
	value: unknown,
	timeZone: string,
	field: string,
): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	return toUtcIso(value, timeZone, field);
}
