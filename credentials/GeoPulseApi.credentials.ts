import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

import {
	INGEST_PATH,
	REQUEST_TIMEOUT_MS,
	isUnderApi,
	normalizeBaseUrl,
} from '../nodes/GeoPulse/shared/security';

function fullUrl(requestOptions: IHttpRequestOptions): string {
	const url = requestOptions.url ?? '';
	if (/^https?:\/\//i.test(url) || !requestOptions.baseURL) return url;
	return `${requestOptions.baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

export class GeoPulseApi implements ICredentialType {
	name = 'geoPulseApi';

	displayName = 'GeoPulse API';

	icon: Icon = { light: 'file:../icons/geopulse.svg', dark: 'file:../icons/geopulse.dark.svg' };

	documentationUrl = 'https://github.com/FDalCol/n8n-nodes-geopulse#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://geopulse.example.com',
			description:
				'Address of your GeoPulse server, without /api. Use the final address (HTTPS recommended): redirects are not followed.',
		},
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Personal API token, created in GeoPulse under Menu → Profile → Security → API tokens. Sent only in the Authorization: Bearer header.',
		},
		{
			displayName: 'GPS Source Token',
			name: 'gpsSourceToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Optional. Token of a Home Assistant location source configured in GeoPulse. When set, it is used instead of the API token for Ingestion → Send Location only. Leave empty to send locations with an API token that has the gps:ingest scope and a connected Home Assistant source.',
		},
	];

	/**
	 * Adds `Authorization: Bearer <token>` only to requests under `<Base URL>/api/`, never to other
	 * hosts or paths. Also forces no redirects and a request timeout.
	 */
	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const baseUrl = normalizeBaseUrl(credentials.baseUrl);
		const url = fullUrl(requestOptions);
		if (!isUnderApi(url, baseUrl)) {
			throw new Error('Refusing to send the GeoPulse token to an address outside <Base URL>/api/');
		}
		const path = new URL(url).pathname.slice(new URL(baseUrl).pathname.replace(/\/+$/, '').length);
		const gpsSourceToken =
			typeof credentials.gpsSourceToken === 'string' ? credentials.gpsSourceToken.trim() : '';
		const apiToken = typeof credentials.apiToken === 'string' ? credentials.apiToken.trim() : '';
		const token = path === INGEST_PATH && gpsSourceToken !== '' ? gpsSourceToken : apiToken;
		if (token === '') {
			throw new Error('The GeoPulse API token is empty');
		}
		const headers = { ...(requestOptions.headers ?? {}) };
		for (const key of Object.keys(headers)) {
			if (['authorization', 'x-api-key', 'cookie'].includes(key.toLowerCase())) delete headers[key];
		}
		headers.Authorization = `Bearer ${token}`;
		return {
			...requestOptions,
			headers,
			disableFollowRedirect: true,
			maxRedirects: 0,
			sendCredentialsOnCrossOriginRedirect: false,
			timeout: requestOptions.timeout ?? REQUEST_TIMEOUT_MS,
		};
	}

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{ String($credentials.baseUrl).trim().replace(/\\/+$/, "") }}',
			url: '/api/v1/api-tokens/current',
			method: 'GET',
			disableFollowRedirect: true,
			timeout: REQUEST_TIMEOUT_MS,
			json: true,
		},
		rules: [
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message:
						'GeoPulse rejected the API token (401): check that it is copied correctly and is not expired or revoked',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'GeoPulse denied access (403): the token is valid but not allowed to make this request',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 404,
					message:
						'Not found (404): check the Base URL (without /api) and that you are using a personal API token, not a session token',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 301,
					message:
						'The server redirected the request: set the final address (e.g. https://…) as Base URL',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 302,
					message:
						'The server redirected the request: set the final address (e.g. https://…) as Base URL',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 307,
					message:
						'The server redirected the request: set the final address (e.g. https://…) as Base URL',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 308,
					message:
						'The server redirected the request: set the final address (e.g. https://…) as Base URL',
				},
			},
		],
	};
}
