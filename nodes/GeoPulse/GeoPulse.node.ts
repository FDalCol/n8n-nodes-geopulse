import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	customApiCallFields,
	customApiCallOperations,
} from './resources/customApiCall/description';
import { executeCustomApiCall } from './resources/customApiCall/execute';
import { exportFields, exportOperations } from './resources/export/description';
import { executeExport } from './resources/export/execute';
import { friendFields, friendOperations } from './resources/friend/description';
import { executeFriend } from './resources/friend/execute';
import { ingestionFields, ingestionOperations } from './resources/ingestion/description';
import { executeIngestion } from './resources/ingestion/execute';
import { locationFields, locationOperations } from './resources/location/description';
import { executeLocation } from './resources/location/execute';
import { shareLinkFields, shareLinkOperations } from './resources/shareLink/description';
import { executeShareLink } from './resources/shareLink/execute';
import { timelineFields, timelineOperations } from './resources/timeline/description';
import { executeTimeline } from './resources/timeline/execute';
import { userFields, userOperations } from './resources/user/description';
import { executeUser } from './resources/user/execute';
import { redact } from './shared/security';
import { getCredentialSecrets } from './shared/transport';

type ResourceExecutor = (
	this: IExecuteFunctions,
	operation: string,
	itemIndex: number,
) => Promise<INodeExecutionData[]>;

const EXECUTORS: Record<string, ResourceExecutor> = {
	customApiCall: executeCustomApiCall,
	export: executeExport,
	friend: executeFriend,
	ingestion: executeIngestion,
	location: executeLocation,
	shareLink: executeShareLink,
	timeline: executeTimeline,
	user: executeUser,
};

export class GeoPulse implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'GeoPulse',
		name: 'geoPulse',
		icon: { light: 'file:geopulse.svg', dark: 'file:geopulse.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description:
			'Read and write data of a self-hosted GeoPulse location timeline: GPS points, timeline, statistics, location ingestion, exports, share links and friends',
		defaults: {
			name: 'GeoPulse',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'geoPulseApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Custom API Call',
						value: 'customApiCall',
						description: 'Call any GeoPulse endpoint under /api/',
					},
					{
						name: 'Export',
						value: 'export',
						description: 'Export GPS and timeline data to a file',
					},
					{
						name: 'Friend',
						value: 'friend',
						description: 'Friends and the locations they share with you',
					},
					{
						name: 'Ingestion',
						value: 'ingestion',
						description: 'Send GPS points to GeoPulse',
					},
					{
						name: 'Location',
						value: 'location',
						description: 'GPS points, last location, path and current status',
					},
					{
						name: 'Share Link',
						value: 'shareLink',
						description: 'Public links to your live location or timeline',
					},
					{
						name: 'Timeline',
						value: 'timeline',
						description: 'Stays, trips, data gaps and statistics',
					},
					{
						name: 'User',
						value: 'user',
						description: 'Profile of the token owner',
					},
				],
				default: 'location',
			},
			...locationOperations,
			...locationFields,
			...timelineOperations,
			...timelineFields,
			...ingestionOperations,
			...ingestionFields,
			...exportOperations,
			...exportFields,
			...shareLinkOperations,
			...shareLinkFields,
			...friendOperations,
			...friendFields,
			...userOperations,
			...userFields,
			...customApiCallOperations,
			...customApiCallFields,
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const credentialSecrets = await getCredentialSecrets(this);

		for (let i = 0; i < items.length; i++) {
			const secrets = [...credentialSecrets];
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				if (resource === 'shareLink' && operation === 'create') {
					const fields = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
					if (typeof fields.password === 'string' && fields.password !== '') {
						secrets.push(fields.password);
					}
				}
				const executor = EXECUTORS[resource];
				if (!executor) {
					throw new NodeOperationError(this.getNode(), `Unsupported resource "${resource}"`, {
						itemIndex: i,
					});
				}
				returnData.push(...(await executor.call(this, operation, i)));
			} catch (error) {
				const message = redact((error as Error)?.message ?? String(error), secrets);
				const rawDescription = (error as { description?: unknown })?.description;
				const description =
					typeof rawDescription === 'string' && rawDescription !== ''
						? redact(rawDescription, secrets)
						: undefined;
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: message, ...(description ? { errorDetails: description } : {}) },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), message, { itemIndex: i, description });
			}
		}

		return [returnData];
	}
}
