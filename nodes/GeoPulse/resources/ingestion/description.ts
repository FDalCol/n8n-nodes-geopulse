import type { INodeProperties } from 'n8n-workflow';

import { show, timeZoneOption } from '../../shared/descriptions';

const R = 'ingestion';

export const ingestionOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		options: [
			{
				name: 'Send Location',
				value: 'sendLocation',
				description:
					'WRITE: stores one or more GPS points in the user’s GeoPulse history (Home Assistant format). Points become part of the timeline and cannot be removed by this node. Requires an API token with the gps:ingest scope connected to a Home Assistant source, or a GPS source token in the credential.',
				action: 'Send a location',
			},
		],
		default: 'sendLocation',
	},
];

export const ingestionFields: INodeProperties[] = [
	{
		displayName: 'Input Mode',
		name: 'inputMode',
		type: 'options',
		options: [
			{
				name: 'Single Point',
				value: 'single',
				description: 'Send the point defined by the fields below',
			},
			{
				name: 'Multiple Points (JSON)',
				value: 'multiple',
				description: 'Send an array of points; more than 1000 points are sent in several requests',
			},
		],
		default: 'single',
		displayOptions: show(R, ['sendLocation']),
	},
	{
		displayName: 'Latitude',
		name: 'latitude',
		type: 'number',
		default: 0,
		required: true,
		typeOptions: { minValue: -90, maxValue: 90, numberPrecision: 7 },
		displayOptions: { show: { resource: [R], operation: ['sendLocation'], inputMode: ['single'] } },
		description: 'Latitude in decimal degrees (WGS84), from -90 to 90',
	},
	{
		displayName: 'Longitude',
		name: 'longitude',
		type: 'number',
		default: 0,
		required: true,
		typeOptions: { minValue: -180, maxValue: 180, numberPrecision: 7 },
		displayOptions: { show: { resource: [R], operation: ['sendLocation'], inputMode: ['single'] } },
		description: 'Longitude in decimal degrees (WGS84), from -180 to 180',
	},
	{
		displayName: 'Timestamp',
		name: 'timestamp',
		type: 'dateTime',
		default: '',
		displayOptions: { show: { resource: [R], operation: ['sendLocation'], inputMode: ['single'] } },
		description: 'When the point was recorded: an n8n date or ISO 8601. Empty = now.',
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: { show: { resource: [R], operation: ['sendLocation'], inputMode: ['single'] } },
		options: [
			{
				displayName: 'Accuracy (M)',
				name: 'accuracy',
				type: 'number',
				default: 0,
				typeOptions: { minValue: 0 },
				description: 'Horizontal accuracy in meters',
			},
			{
				displayName: 'Altitude (M)',
				name: 'altitude',
				type: 'number',
				default: 0,
				description: 'Altitude in meters',
			},
			{
				displayName: 'Battery (%)',
				name: 'battery',
				type: 'number',
				default: 100,
				typeOptions: { minValue: 0, maxValue: 100 },
				description: 'Battery level of the device, from 0 to 100',
			},
			{
				displayName: 'Device ID',
				name: 'deviceId',
				type: 'string',
				default: '',
				description: 'Identifier of the device stored with the point',
			},
			{
				displayName: 'Speed (M/s)',
				name: 'speed',
				type: 'number',
				default: 0,
				typeOptions: { minValue: 0 },
				description: 'Speed in meters per second (GeoPulse stores it in km/h)',
			},
		],
	},
	{
		displayName: 'Points',
		name: 'points',
		type: 'json',
		default:
			'[\n  {\n    "latitude": 45.4642,\n    "longitude": 9.19,\n    "timestamp": "2025-06-01T08:00:00Z"\n  }\n]',
		required: true,
		displayOptions: {
			show: { resource: [R], operation: ['sendLocation'], inputMode: ['multiple'] },
		},
		description:
			'Array of points. Each point: latitude (or lat), longitude (or lng/lon), timestamp (ISO 8601, required), and optional accuracy (m), altitude (m), speed (m/s), battery (0-100), deviceId.',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(R, ['sendLocation']),
		options: [timeZoneOption],
	},
];
