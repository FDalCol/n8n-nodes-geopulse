import type { INodeProperties } from 'n8n-workflow';

import { show, timeZoneOption, waitFields } from '../../shared/descriptions';

const R = 'export';

export const exportOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		options: [
			{
				name: 'Create Export',
				value: 'create',
				description:
					'WRITE: starts a background export job of the user’s data for a period in GeoPulse (the number of export jobs per user is limited). Optionally waits for it and downloads the file.',
				action: 'Create an export',
			},
			{
				name: 'Download Export',
				value: 'download',
				description: 'Download the file of a completed export job as n8n binary data',
				action: 'Download an export',
			},
			{
				name: 'Get Export Status',
				value: 'getStatus',
				description: 'Get the status and progress of an export job',
				action: 'Get export status',
			},
		],
		default: 'create',
	},
];

export const exportFields: INodeProperties[] = [
	{
		displayName: 'Format',
		name: 'format',
		type: 'options',
		options: [
			{
				name: 'CSV',
				value: 'csv',
				description: 'Raw GPS points as CSV',
			},
			{
				name: 'GeoJSON',
				value: 'geojson',
				description: 'Raw GPS points as GeoJSON',
			},
			{
				name: 'GeoPulse (ZIP)',
				value: 'geopulse',
				description: 'ZIP that can be imported back into GeoPulse',
			},
			{
				name: 'GPX',
				value: 'gpx',
				description: 'Raw GPS points as GPX',
			},
			{
				name: 'OwnTracks',
				value: 'owntracks',
				description: 'Raw GPS points in OwnTracks JSON format',
			},
		],
		default: 'geopulse',
		displayOptions: show(R, ['create']),
	},
	{
		displayName: 'From',
		name: 'from',
		type: 'dateTime',
		default: '',
		required: true,
		displayOptions: show(R, ['create']),
		description:
			'Start of the period: an n8n date or ISO 8601. Without an offset it is read in the selected time zone.',
	},
	{
		displayName: 'To',
		name: 'to',
		type: 'dateTime',
		default: '',
		required: true,
		displayOptions: show(R, ['create']),
		description:
			'End of the period: an n8n date or ISO 8601. Without an offset it is read in the selected time zone.',
	},
	{
		displayName: 'Data Types',
		name: 'dataTypes',
		type: 'multiOptions',
		options: [
			{ name: 'Data Gaps', value: 'datagaps' },
			{ name: 'Favorites', value: 'favorites' },
			{ name: 'Location Sources', value: 'locationsources' },
			{ name: 'Raw GPS Points', value: 'rawgps' },
			{ name: 'Reverse Geocoding', value: 'reversegeocodinglocation' },
			{ name: 'Timeline', value: 'timeline' },
			{ name: 'Timeline Labels', value: 'timelinelabels' },
			{ name: 'User Info', value: 'userinfo' },
		],
		default: ['rawgps', 'timeline'],
		displayOptions: { show: { resource: [R], operation: ['create'], format: ['geopulse'] } },
		description: 'What to include in the GeoPulse ZIP. Empty = raw GPS points only.',
	},
	{
		displayName: 'GPX Layout',
		name: 'gpxLayout',
		type: 'options',
		options: [
			{ name: 'Single File', value: 'single' },
			{ name: 'ZIP, One File per Day', value: 'zip-per-day' },
			{ name: 'ZIP, One File per Trip', value: 'zip-per-trip' },
		],
		default: 'single',
		displayOptions: { show: { resource: [R], operation: ['create'], format: ['gpx'] } },
	},
	{
		displayName: 'OwnTracks Layout',
		name: 'owntracksLayout',
		type: 'options',
		options: [
			{ name: 'JSON Array', value: 'array' },
			{ name: 'OCAT', value: 'ocat' },
		],
		default: 'array',
		displayOptions: { show: { resource: [R], operation: ['create'], format: ['owntracks'] } },
	},
	...waitFields(R, ['create'], 'export'),
	{
		displayName: 'Download',
		name: 'download',
		type: 'boolean',
		default: true,
		displayOptions: { show: { resource: [R], operation: ['create'], waitForCompletion: [true] } },
		description: 'Whether to download the file as binary data once the export is completed',
	},
	{
		displayName: 'Export Job ID',
		name: 'exportJobId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show(R, ['getStatus', 'download']),
		description: 'ID of the export job, as returned by Create Export (exportJobId)',
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		displayOptions: show(R, ['download']),
		description: 'Name of the binary property that receives the downloaded file',
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		displayOptions: {
			show: { resource: [R], operation: ['create'], waitForCompletion: [true], download: [true] },
		},
		description: 'Name of the binary property that receives the downloaded file',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(R, ['create']),
		options: [timeZoneOption],
	},
];
