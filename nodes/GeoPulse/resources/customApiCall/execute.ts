import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodeExecutionData,
} from 'n8n-workflow';

import { normalizeApiPath } from '../../shared/security';
import { geoPulseRequest } from '../../shared/transport';
import { listToItems, objectToItem, parseJsonText } from '../../shared/utils';

const METHODS: IHttpRequestMethods[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function readBody(ctx: IExecuteFunctions, i: number): IDataObject | IDataObject[] {
	const raw = ctx.getNodeParameter('body', i, '{}');
	let value: unknown = raw;
	if (typeof raw === 'string') {
		if (raw.trim() === '') return {};
		const parsed = parseJsonText(raw);
		if (!parsed) throw new Error('Body is not valid JSON');
		value = parsed.value;
	}
	if (value === null || typeof value !== 'object') {
		throw new Error('Body must be a JSON object or array');
	}
	return value as IDataObject | IDataObject[];
}

export async function executeCustomApiCall(
	this: IExecuteFunctions,
	operation: string,
	i: number,
): Promise<INodeExecutionData[]> {
	if (operation !== 'request')
		throw new Error(`Unsupported operation "${operation}" for Custom API Call`);

	const method = this.getNodeParameter('method', i) as IHttpRequestMethods;
	if (!METHODS.includes(method)) throw new Error(`Unsupported method "${String(method)}"`);
	const path = normalizeApiPath(this.getNodeParameter('path', i));

	const qs: IDataObject = {};
	const query = this.getNodeParameter('queryParameters', i, {}) as {
		parameter?: Array<{ name?: string; value?: string }>;
	};
	for (const parameter of query.parameter ?? []) {
		const name = String(parameter.name ?? '').trim();
		if (name === '') continue;
		if (/^(api[_-]?key|access[_-]?token|token)$/i.test(name)) {
			throw new Error(
				`Query parameter "${name}" is not allowed: the token is sent only in the Authorization header`,
			);
		}
		qs[name] = parameter.value ?? '';
	}

	const sendBody = method !== 'GET' && (this.getNodeParameter('sendBody', i, false) as boolean);
	const body = sendBody ? readBody(this, i) : undefined;

	const response = await geoPulseRequest(this, { method, path, qs, body });
	const data = response.body;
	if (Array.isArray(data)) {
		const split = this.getNodeParameter('splitIntoItems', i, true) as boolean;
		return listToItems(
			data.map((element) =>
				element !== null && typeof element === 'object'
					? (element as IDataObject)
					: { value: element },
			),
			split,
			i,
		);
	}
	if (data !== null && typeof data === 'object') return objectToItem(data as IDataObject, i);
	return objectToItem(
		{ statusCode: response.statusCode, ...(data === undefined ? {} : { data: data as string }) },
		i,
	);
}
