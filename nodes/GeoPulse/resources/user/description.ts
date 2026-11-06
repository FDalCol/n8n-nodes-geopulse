import type { INodeProperties } from 'n8n-workflow';

export const userOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['user'] } },
		options: [
			{
				name: 'Get Profile',
				value: 'getProfile',
				description:
					'Get the profile of the token owner: ID, email, name, role, time zone and preferences',
				action: 'Get the user profile',
			},
		],
		default: 'getProfile',
	},
];

export const userFields: INodeProperties[] = [];
