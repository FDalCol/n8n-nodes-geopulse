import type { INodeProperties } from 'n8n-workflow';

import {
	periodFields,
	returnAllAndLimit,
	show,
	splitIntoItemsField,
	timeZoneOption,
} from '../../shared/descriptions';

const R = 'location';

export const locationOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		options: [
			{
				name: 'Get Current Status',
				value: 'getCurrentStatus',
				description:
					'Get what the user is doing now (stay, trip or data gap), the last GPS point and today’s totals',
				action: 'Get the current status',
			},
			{
				name: 'Get GPS Points',
				value: 'getPoints',
				description: 'Get the raw GPS points of a period, newest first by default',
				action: 'Get GPS points',
			},
			{
				name: 'Get Last Location',
				value: 'getLastLocation',
				description: 'Get the most recent GPS point of the user',
				action: 'Get the last location',
			},
			{
				name: 'Get Path',
				value: 'getPath',
				description: 'Get the GPS path of a period, split into segments at data gaps',
				action: 'Get the GPS path',
			},
			{
				name: 'Get Point Place',
				value: 'getPointPlace',
				description:
					'Get the place name of a GPS point by ID: the favorite it falls into or its geocoded address',
				action: 'Get the place of a GPS point',
			},
			{
				name: 'Get Summary',
				value: 'getSummary',
				description: 'Get GPS point counts: total, today, first and last point, filtered points',
				action: 'Get the GPS summary',
			},
		],
		default: 'getLastLocation',
	},
];

const sourceTypes = [
	'COLOTA',
	'CSV',
	'DAWARICH',
	'GEOJSON',
	'GOOGLE_TIMELINE',
	'GPSLOGGER',
	'GPX',
	'HOME_ASSISTANT',
	'MANUAL',
	'MOBILE_APP',
	'OVERLAND',
	'OWNTRACKS',
	'TRACCAR',
].map((value) => ({ name: value, value }));

export const locationFields: INodeProperties[] = [
	...periodFields(R, ['getPoints', 'getPath', 'getSummary'], false),
	...returnAllAndLimit(R, ['getPoints']),
	splitIntoItemsField(R, ['getPoints']),
	{
		displayName: 'Point ID',
		name: 'pointId',
		type: 'number',
		default: 0,
		required: true,
		typeOptions: { minValue: 1 },
		displayOptions: show(R, ['getPointPlace']),
		description: 'ID of the GPS point, as returned by Get GPS Points',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(R, ['getPoints']),
		options: [
			{
				displayName: 'Include Location Time Zones',
				name: 'includeLocationTimezones',
				type: 'boolean',
				default: false,
				description: 'Whether to add the local time zone of each point (locationTimezone)',
			},
			{
				displayName: 'Sort Direction',
				name: 'sortDirection',
				type: 'options',
				options: [
					{ name: 'Newest First', value: 'desc' },
					{ name: 'Oldest First', value: 'asc' },
				],
				default: 'desc',
			},
			{
				displayName: 'Source Types',
				name: 'sourceTypes',
				type: 'multiOptions',
				options: sourceTypes,
				default: [],
				description: 'Only return points from these sources',
			},
			timeZoneOption,
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(R, ['getPath', 'getSummary']),
		options: [
			{
				displayName: 'Simplify Path',
				name: 'simplify',
				type: 'boolean',
				default: true,
				displayOptions: { show: { '/operation': ['getPath'] } },
				description: 'Whether GeoPulse should simplify the path to fewer points',
			},
			timeZoneOption,
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(R, ['getPointPlace']),
		options: [
			{
				displayName: 'Include Location Time Zone',
				name: 'includeLocationTimezones',
				type: 'boolean',
				default: false,
				description: 'Whether to add the local time zone of the point (locationTimezone)',
			},
		],
	},
];
