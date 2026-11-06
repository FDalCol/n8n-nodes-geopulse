import type { INodeProperties } from 'n8n-workflow';

import { show, splitIntoItemsField } from '../../shared/descriptions';

const R = 'customApiCall';

export const customApiCallOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		options: [
			{
				name: 'Make a Request',
				value: 'request',
				description:
					'Call any GeoPulse REST endpoint under /api/ with the credential token. POST, PUT, PATCH and DELETE CHANGE OR DELETE DATA: use them only when explicitly asked and with the exact endpoint from the GeoPulse API reference.',
				action: 'Make a custom API call',
			},
		],
		default: 'request',
	},
];

export const customApiCallFields: INodeProperties[] = [
	{
		displayName: 'Method',
		name: 'method',
		type: 'options',
		options: [
			{ name: 'DELETE', value: 'DELETE' },
			{ name: 'GET', value: 'GET' },
			{ name: 'PATCH', value: 'PATCH' },
			{ name: 'POST', value: 'POST' },
			{ name: 'PUT', value: 'PUT' },
		],
		default: 'GET',
		displayOptions: show(R, ['request']),
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		default: '/api/v1/',
		required: true,
		placeholder: '/api/v1/timeline/count',
		displayOptions: show(R, ['request']),
		description:
			'Path under /api/, e.g. /api/v1/timeline/count or v1/timeline/count. Absolute URLs, "..", query strings and paths outside /api/ are rejected.',
	},
	{
		displayName: 'Query Parameters',
		name: 'queryParameters',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Parameter',
		default: {},
		displayOptions: show(R, ['request']),
		options: [
			{
				displayName: 'Parameter',
				name: 'parameter',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
					},
				],
			},
		],
	},
	{
		displayName: 'Send Body',
		name: 'sendBody',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: { resource: [R], operation: ['request'], method: ['POST', 'PUT', 'PATCH', 'DELETE'] },
		},
		description: 'Whether to send a JSON body',
	},
	{
		displayName: 'Body (JSON)',
		name: 'body',
		type: 'json',
		default: '{}',
		displayOptions: {
			show: {
				resource: [R],
				operation: ['request'],
				method: ['POST', 'PUT', 'PATCH', 'DELETE'],
				sendBody: [true],
			},
		},
		description: 'JSON object or array sent as the request body',
	},
	splitIntoItemsField(R, ['request']),
];
