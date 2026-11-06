import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { geoPulseApiRequest } from '../../shared/transport';
import { objectToItem } from '../../shared/utils';

export async function executeUser(
	this: IExecuteFunctions,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	if (operation !== 'getProfile') throw new Error(`Unsupported operation "${operation}" for User`);
	const profile = (await geoPulseApiRequest(this, 'GET', '/api/v1/users/me')) as IDataObject;
	return objectToItem(profile ?? {}, i);
}
