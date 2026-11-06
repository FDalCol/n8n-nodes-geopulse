import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	INodeExecutionData,
} from 'n8n-workflow';

import {
	checkQueryParameterName,
	collectPasswords,
	normalizeApiPath,
	redact,
	stripPasswords,
} from '../../shared/security';
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
		checkQueryParameterName(name);
		Object.defineProperty(qs, name, {
			value: String(parameter.value ?? ''),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}

	const sendBody = method !== 'GET' && (this.getNodeParameter('sendBody', i, false) as boolean);
	const body = sendBody ? readBody(this, i) : undefined;

	// Passwords in the body (e.g. of a share link) are removed from errors and from the output.
	const secrets = collectPasswords(body);
	const response = await geoPulseRequest(this, { method, path, qs, body, secrets });
	const data =
		typeof response.body === 'string' && secrets.length
			? redact(response.body, secrets)
			: stripPasswords(response.body);
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
