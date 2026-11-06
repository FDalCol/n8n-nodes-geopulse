import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';

import { isValidTimeZone, optionalUtcIso, toUtcIso } from './dates';

/** Time zone for dates without an offset: the "Time Zone" option, else the workflow time zone. */
export function resolveTimeZone(ctx: IExecuteFunctions, value: unknown): string {
	const timeZone =
		typeof value === 'string' && value.trim() !== '' ? value.trim() : ctx.getTimezone();
	if (!isValidTimeZone(timeZone)) {
		throw new Error(
			`Unknown time zone "${String(timeZone)}": use an IANA name such as Europe/Rome`,
		);
	}
	return timeZone;
}

export function getOptions(ctx: IExecuteFunctions, itemIndex: number): IDataObject {
	return (ctx.getNodeParameter('options', itemIndex, {}) ?? {}) as IDataObject;
}

/** Reads the From / To parameters as UTC ISO instants and checks their order. */
export function readPeriod(
	ctx: IExecuteFunctions,
	itemIndex: number,
	timeZone: string,
	required: boolean,
): { from?: string; to?: string } {
	const fromValue = ctx.getNodeParameter('from', itemIndex, '');
	const toValue = ctx.getNodeParameter('to', itemIndex, '');
	const from = required
		? toUtcIso(fromValue, timeZone, 'From')
		: optionalUtcIso(fromValue, timeZone, 'From');
	const to = required ? toUtcIso(toValue, timeZone, 'To') : optionalUtcIso(toValue, timeZone, 'To');
	if (from && to && Date.parse(from) > Date.parse(to)) {
		throw new Error('From must be before To');
	}
	return { from, to };
}
