import type { INodeProperties } from 'n8n-workflow';

import { show, splitIntoItemsField, timeZoneOption } from '../../shared/descriptions';

const R = 'shareLink';

export const shareLinkOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: [R] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description:
					'WRITE, PUBLIC: creates a public link that lets anyone with the URL see the user’s live location or timeline. Set a password and an expiration whenever possible. Use only when explicitly asked.',
				action: 'Create a share link',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'WRITE: deletes (revokes) a share link; the link stops working immediately',
				action: 'Delete a share link',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description:
					'List the user’s share links with type, settings, expiration, view count and URL',
				action: 'Get many share links',
			},
		],
		default: 'getAll',
	},
];

export const shareLinkFields: INodeProperties[] = [
	splitIntoItemsField(R, ['getAll']),
	{
		displayName: 'Share Link ID',
		name: 'shareLinkId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show(R, ['delete']),
		description: 'ID of the share link to delete (UUID)',
	},
	{
		displayName: 'Name',
		name: 'name',
		type: 'string',
		default: '',
		required: true,
		displayOptions: show(R, ['create']),
		description: 'Name of the link, shown to you in GeoPulse',
	},
	{
		displayName: 'Share Type',
		name: 'shareType',
		type: 'options',
		options: [
			{
				name: 'Live Location',
				value: 'LIVE_LOCATION',
				description: 'Your current location, optionally with recent movement',
			},
			{
				name: 'Timeline',
				value: 'TIMELINE',
				description: 'Your timeline between a start and an end date',
			},
		],
		default: 'LIVE_LOCATION',
		displayOptions: show(R, ['create']),
	},
	{
		displayName: 'Start Date',
		name: 'startDate',
		type: 'dateTime',
		default: '',
		required: true,
		displayOptions: { show: { resource: [R], operation: ['create'], shareType: ['TIMELINE'] } },
		description: 'Start of the shared timeline: an n8n date or ISO 8601',
	},
	{
		displayName: 'End Date',
		name: 'endDate',
		type: 'dateTime',
		default: '',
		required: true,
		displayOptions: { show: { resource: [R], operation: ['create'], shareType: ['TIMELINE'] } },
		description: 'End of the shared timeline: an n8n date or ISO 8601',
	},
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: show(R, ['create']),
		options: [
			{
				displayName: 'Expires At',
				name: 'expiresAt',
				type: 'dateTime',
				default: '',
				description: 'When the link stops working: an n8n date or ISO 8601. Empty = never.',
			},
			{
				displayName: 'History Hours',
				name: 'historyHours',
				type: 'number',
				default: 24,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { '/shareType': ['LIVE_LOCATION'] } },
				description: 'Hours of recent movement to show with Show History',
			},
			{
				displayName: 'Password',
				name: 'password',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description: 'Password required to open the link. Never returned in the output.',
			},
			{
				displayName: 'Show Current Location',
				name: 'showCurrentLocation',
				type: 'boolean',
				default: false,
				displayOptions: { show: { '/shareType': ['TIMELINE'] } },
				description: 'Whether a timeline link also shows your current location',
			},
			{
				displayName: 'Show History',
				name: 'showHistory',
				type: 'boolean',
				default: false,
				displayOptions: { show: { '/shareType': ['LIVE_LOCATION'] } },
				description: 'Whether a live location link also shows recent movement',
			},
			{
				displayName: 'Show Notes',
				name: 'showNotes',
				type: 'boolean',
				default: false,
				displayOptions: { show: { '/shareType': ['TIMELINE'] } },
				description: 'Whether a timeline link shows your notes',
			},
			{
				displayName: 'Show Photos',
				name: 'showPhotos',
				type: 'boolean',
				default: false,
				displayOptions: { show: { '/shareType': ['TIMELINE'] } },
				description:
					'Whether a timeline link shows Immich photos (requires the Immich integration)',
			},
			timeZoneOption,
		],
	},
];
