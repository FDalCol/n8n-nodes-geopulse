import type { INodeProperties } from 'n8n-workflow';

type Show = { resource: string[]; operation: string[] };

export function show(resource: string, operations: string[]): { show: Show } {
	return { show: { resource: [resource], operation: operations } };
}

/** From / To fields for operations that read a time range. */
export function periodFields(
	resource: string,
	operations: string[],
	required: boolean,
): INodeProperties[] {
	const fromDescription = required
		? 'Start of the period: an n8n date or ISO 8601. Without an offset it is read in the selected time zone.'
		: 'Start of the period: an n8n date or ISO 8601, read in the selected time zone when it has no offset. Empty = from the first data.';
	const toDescription = required
		? 'End of the period: an n8n date or ISO 8601. Without an offset it is read in the selected time zone.'
		: 'End of the period: an n8n date or ISO 8601, read in the selected time zone when it has no offset. Empty = now.';
	return [
		{
			displayName: 'From',
			name: 'from',
			type: 'dateTime',
			default: '',
			required,
			displayOptions: show(resource, operations),
			description: fromDescription,
		},
		{
			displayName: 'To',
			name: 'to',
			type: 'dateTime',
			default: '',
			required,
			displayOptions: show(resource, operations),
			description: toDescription,
		},
	];
}

export const timeZoneOption: INodeProperties = {
	displayName: 'Time Zone',
	name: 'timeZone',
	type: 'string',
	default: '',
	placeholder: 'Europe/Rome',
	description:
		'IANA time zone used for dates entered without an offset. Empty = the workflow time zone. GeoPulse always answers in UTC.',
};

export function splitIntoItemsField(resource: string, operations: string[]): INodeProperties {
	return {
		displayName: 'Split Into Items',
		name: 'splitIntoItems',
		type: 'boolean',
		default: true,
		displayOptions: show(resource, operations),
		description:
			'Whether to output one item per element. When off, a single item is returned with the list in "items" and its length in "count".',
	};
}

export function returnAllAndLimit(resource: string, operations: string[]): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			displayOptions: show(resource, operations),
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1 },
			displayOptions: {
				show: { resource: [resource], operation: operations, returnAll: [false] },
			},
			description: 'Max number of results to return',
		},
	];
}

/** Wait For Completion with poll interval and timeout (1 s – 24 h). */
export function waitFields(
	resource: string,
	operations: string[],
	what: string,
): INodeProperties[] {
	return [
		{
			displayName: 'Wait For Completion',
			name: 'waitForCompletion',
			type: 'boolean',
			default: false,
			displayOptions: show(resource, operations),
			description: `Whether to wait until the ${what} has finished before continuing`,
		},
		{
			displayName: 'Poll Interval (Seconds)',
			name: 'pollInterval',
			type: 'number',
			default: 5,
			typeOptions: { minValue: 1, maxValue: 86400 },
			displayOptions: {
				show: { resource: [resource], operation: operations, waitForCompletion: [true] },
			},
			description: 'Seconds between status checks, from 1 to 86400 (24 hours)',
		},
		{
			displayName: 'Timeout (Seconds)',
			name: 'waitTimeout',
			type: 'number',
			default: 600,
			typeOptions: { minValue: 1, maxValue: 86400 },
			displayOptions: {
				show: { resource: [resource], operation: operations, waitForCompletion: [true] },
			},
			description: `Maximum time to wait for the ${what}, from 1 to 86400 seconds (24 hours). The node fails when it is exceeded.`,
		},
	];
}
