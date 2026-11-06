import type { IDataObject, IHttpRequestOptions, INodeExecutionData } from 'n8n-workflow';

export declare const TOKEN: string;
export declare const GPS_TOKEN: string;
export declare const WRONG_TOKEN: string;
export declare const SHARE_PASSWORD: string;

export interface RecordedRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

export interface Reply {
	status?: number;
	json?: unknown;
	body?: string | Buffer;
	headers?: Record<string, string>;
}

export type Handler = (req: RecordedRequest) => Reply | Promise<Reply>;

export interface FakeServer {
	url: string;
	requests: RecordedRequest[];
	violations: string[];
	setHandler(handler: Handler): void;
	close(): Promise<void>;
}

export declare function startServer(
	handler?: Handler,
	options?: { checkAuth?: boolean },
): Promise<FakeServer>;

export declare function problem(
	status: number,
	code: string,
	detail: string,
	extra?: IDataObject,
): Reply;

export declare function fakeHttpRequest(options: IHttpRequestOptions): Promise<unknown>;

export interface CredentialData extends IDataObject {
	baseUrl: string;
	apiToken: string;
	gpsSourceToken?: string;
}

export declare function credentials(
	baseUrl: string,
	extra?: Partial<CredentialData>,
): CredentialData;

export interface ExecuteContextOptions {
	params: Record<string, unknown>;
	credentials: CredentialData;
	items?: INodeExecutionData[];
	continueOnFail?: boolean;
	timezone?: string;
}

export declare function executeContext(options: ExecuteContextOptions): {
	ctx: { helpers: Record<string, unknown> } & Record<string, unknown>;
	binaries: Array<{ fileName?: string; mimeType?: string; size: number }>;
};

export interface PollContextOptions {
	params: Record<string, unknown>;
	credentials: CredentialData;
	staticData?: IDataObject;
	mode?: 'manual' | 'trigger';
}

export declare function pollContext(options: PollContextOptions): {
	ctx: Record<string, unknown>;
	staticData: IDataObject;
};

export declare function runCredentialTest(
	creds: CredentialData,
): Promise<{ status: 'OK' | 'Error'; message: string }>;

export declare function startTricklingServer(): Promise<{ url: string; close(): Promise<void> }>;
