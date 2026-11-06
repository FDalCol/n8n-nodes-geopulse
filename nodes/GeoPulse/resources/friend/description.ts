import type { INodeProperties } from 'n8n-workflow';

import { show, splitIntoItemsField } from '../../shared/descriptions';

const R = 'friend';

export const friendOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		options: [
			{
				name: 'Get Location',
				value: 'getLocation',
				description:
					'Get the latest GPS point of a friend. Works only if the friend shares their live location with you.',
				action: 'Get a friend location',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description:
					'List friends with their last known location (when they share it) and the permissions on both sides',
				action: 'Get many friends',
			},
		],
		default: 'getAll',
	},
];

export const friendFields: INodeProperties[] = [
	splitIntoItemsField(R, ['getAll']),
	{
		displayName: 'Friend ID',
		name: 'friendId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show(R, ['getLocation']),
		description: 'User ID of the friend (friendId in Get Many)',
	},
];
