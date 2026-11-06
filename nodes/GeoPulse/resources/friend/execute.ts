import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { geoPulseApiRequest } from '../../shared/transport';
import { asArray, listToItems, objectToItem } from '../../shared/utils';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function executeFriend(
	this: IExecuteFunctions,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	if (operation === 'getAll') {
		const friends = asArray(await geoPulseApiRequest(this, 'GET', '/api/v1/friends'));
		const split = this.getNodeParameter('splitIntoItems', i, true) as boolean;
		return listToItems(friends, split, i);
	}

	if (operation === 'getLocation') {
		const friendId = String(this.getNodeParameter('friendId', i) ?? '').trim();
		if (!UUID_PATTERN.test(friendId))
			throw new Error('Friend ID must be a UUID (friendId in Get Many)');
		const point = (await geoPulseApiRequest(
			this,
			'GET',
			`/api/v1/friends/${friendId}/location`,
		)) as IDataObject | undefined;
		if (!point || Object.keys(point).length === 0) {
			return objectToItem({ friendId, found: false }, i);
		}
		return objectToItem({ friendId, found: true, ...point }, i);
	}

	throw new Error(`Unsupported operation "${operation}" for Friend`);
}
