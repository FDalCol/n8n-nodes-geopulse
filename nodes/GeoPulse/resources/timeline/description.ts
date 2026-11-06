import type { INodeProperties } from 'n8n-workflow';

import {
	periodFields,
	show,
	splitIntoItemsField,
	timeZoneOption,
	waitFields,
} from '../../shared/descriptions';

const R = 'timeline';
const LIST_OPS = ['getTimeline', 'getStays', 'getTrips', 'getDataGaps'];

export const timelineOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		options: [
			{
				name: 'Get Data Gaps',
				value: 'getDataGaps',
				description: 'Get the periods without GPS data in a period',
				action: 'Get data gaps',
			},
			{
				name: 'Get Statistics',
				value: 'getStatistics',
				description:
					'Get statistics for a period: total distance, time moving, average speed, most visited places and frequent routes',
				action: 'Get statistics',
			},
			{
				name: 'Get Stays',
				value: 'getStays',
				description: 'Get the stays (time spent at a place) in a period',
				action: 'Get stays',
			},
			{
				name: 'Get Timeline',
				value: 'getTimeline',
				description: 'Get stays, trips and data gaps of a period in chronological order',
				action: 'Get the timeline',
			},
			{
				name: 'Get Trips',
				value: 'getTrips',
				description: 'Get the trips (movement between places) in a period',
				action: 'Get trips',
			},
			{
				name: 'Regenerate Timeline',
				value: 'regenerate',
				description:
					'WRITE, HEAVY: rebuilds the ENTIRE timeline of the user from all GPS points (GeoPulse does not support regenerating only a period). It can take minutes, stays and trips get new IDs, and only one job per user can run at a time. Use only when explicitly asked.',
				action: 'Regenerate the whole timeline',
			},
		],
		default: 'getTimeline',
	},
];

export const timelineFields: INodeProperties[] = [
	...periodFields(R, [...LIST_OPS, 'getStatistics'], false),
	splitIntoItemsField(R, LIST_OPS),
	...waitFields(R, ['regenerate'], 'timeline regeneration'),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(R, LIST_OPS),
		options: [
			{
				displayName: 'Include Location Time Zones',
				name: 'includeLocationTimezones',
				type: 'boolean',
				default: false,
				description: 'Whether to add the local time zone of each stay, trip endpoint and data gap',
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
		displayOptions: show(R, ['getStatistics']),
		options: [timeZoneOption],
	},
];
