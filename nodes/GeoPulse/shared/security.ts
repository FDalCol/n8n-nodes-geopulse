/**
 * Security helpers shared by the GeoPulse nodes and credential.
 *
 * Nothing in this module logs or returns secrets: every message that can reach the user goes
 * through `redact()` first.
 */

/** Every request made by the nodes must stay under this prefix of the Base URL. */
export const API_PREFIX = '/api/';

/** Timeout for a single HTTP request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Total time allowed for downloading an export file (the 30 s idle timeout still applies). */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Largest JSON response accepted. */
export const MAX_JSON_BYTES = 50 * 1024 * 1024;

/** Largest export file accepted. */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

/** Upper bound of pages fetched by one paginated call, so a server that ignores paging cannot loop forever. */
export const MAX_PAGES = 200;

/** Path of the ingestion endpoint that may use the optional GPS source token instead of the API token. */
export const INGEST_PATH = '/api/v1/gps/ingest/home-assistant/batch';

const REDACTED = '[REDACTED]';

/** Longest message kept by `redact()`, so server-controlled text cannot make the regexes slow. */
const MAX_MESSAGE_LENGTH = 2000;

function parseUrl(value: string, base?: string): URL | undefined {
	try {
		return new URL(value, base);
	} catch {
		return undefined;
	}
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function decodeSegment(segment: string): string | undefined {
	try {
		return decodeURIComponent(segment);
	} catch {
		return undefined;
	}
}

/**
 * True when every segment of a URL path is safe after one decoding: no ".", "..", matrix
 * parameters (";"), separators, backslashes or control characters, and valid UTF-8 (overlong
 * encodings such as %c0%ae are rejected by decodeURIComponent).
 */
export function hasSafeSegments(pathname: string): boolean {
	if (pathname.includes(';') || /%(25|3b)/i.test(pathname)) return false;
	for (const segment of pathname.split('/')) {
		const decoded = decodeSegment(segment);
		if (decoded === undefined) return false;
		if (decoded === '.' || decoded === '..') return false;
		if (/[/\\;]/.test(decoded) || hasControlCharacters(decoded)) return false;
	}
	return true;
}

/**
 * Validates and normalizes the Base URL of the credential: http(s) only, no user info, query or
 * fragment, trailing slashes removed. A path prefix (reverse proxy sub-path) is kept.
 */
export function normalizeBaseUrl(raw: unknown): string {
	if (typeof raw !== 'string' || raw.trim() === '') {
		throw new Error('Base URL is required');
	}
	const trimmed = raw.trim().replace(/\/+$/, '');
	if (/[?#]/.test(trimmed)) {
		throw new Error('Base URL must not contain a query string or a fragment');
	}
	if (/[\s\\]/.test(trimmed)) {
		throw new Error('Base URL must not contain spaces or backslashes');
	}
	const url = parseUrl(trimmed);
	if (!url) {
		throw new Error('Base URL is not a valid URL, e.g. https://geopulse.example.com');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Base URL must start with http:// or https://');
	}
	if (url.username !== '' || url.password !== '') {
		throw new Error('Base URL must not contain a username or password');
	}
	if (url.search !== '' || url.hash !== '') {
		throw new Error('Base URL must not contain a query string or a fragment');
	}
	const path = url.pathname.replace(/\/+$/, '');
	return `${url.protocol}//${url.host}${path}`;
}

/**
 * Turns the path of a Custom API Call into an absolute path under `/api/`.
 * Accepts `/api/v1/...`, `api/v1/...` or a path relative to `/api/` such as `v1/...`.
 * Rejects absolute URLs, traversal, encoded separators, query strings and paths outside `/api/`.
 */
export function normalizeApiPath(input: unknown): string {
	if (typeof input !== 'string' || input.trim() === '') {
		throw new Error('Path is required');
	}
	let path = input.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) {
		throw new Error(
			'Absolute URLs are not allowed: enter a path under /api/, e.g. /api/v1/timeline',
		);
	}
	if (/[\\\s]/.test(path) || hasControlCharacters(path)) {
		throw new Error('Path must not contain spaces, backslashes or control characters');
	}
	if (/[?#]/.test(path)) {
		throw new Error('Path must not contain a query string: use the Query Parameters field');
	}
	if (/%(2e|2f|5c|00|25)/i.test(path) || /%(?![0-9a-f]{2})/i.test(path)) {
		throw new Error(
			'Path must not contain encoded (or double-encoded) dots, slashes, backslashes or percent signs',
		);
	}
	if (!/^[A-Za-z0-9\-._~!$&'()*+,=:@/%]+$/.test(path)) {
		throw new Error('Path contains characters that are not allowed in a URL path (including ";")');
	}
	if (!hasSafeSegments(path)) {
		throw new Error('Path must not contain "." or ".." segments, ";" or invalid percent-encoding');
	}
	if (!path.startsWith('/')) {
		path = path.startsWith('api/') ? `/${path}` : `${API_PREFIX}${path}`;
	}
	const segments = path.split('/').slice(1);
	if (segments.some((segment) => segment === '..' || segment === '.')) {
		throw new Error('Path must not contain "." or ".." segments');
	}
	if (segments.slice(0, -1).some((segment) => segment === '')) {
		throw new Error('Path must not contain empty segments');
	}
	if (!path.startsWith(API_PREFIX) || path.length <= API_PREFIX.length) {
		throw new Error('Path must be under /api/, e.g. /api/v1/timeline');
	}
	return path;
}

const FORBIDDEN_QUERY_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validates a query parameter name of a Custom API Call: no prototype keys, no token-like names
 * (the token travels only in the Authorization header) and only common characters.
 */
export function checkQueryParameterName(name: string): string {
	if (FORBIDDEN_QUERY_NAMES.has(name) || FORBIDDEN_QUERY_NAMES.has(name.toLowerCase())) {
		throw new Error(`Query parameter "${name}" is not allowed`);
	}
	if (/^(api[_-]?key|access[_-]?token|token|authorization)$/i.test(name)) {
		throw new Error(
			`Query parameter "${name}" is not allowed: the token is sent only in the Authorization header`,
		);
	}
	if (!/^[A-Za-z0-9_.\-[\]]{1,100}$/.test(name)) {
		throw new Error(`Query parameter "${name}" contains characters that are not allowed`);
	}
	return name;
}

/** True when `url` is the Base URL followed by a path under `/api/`, with no traversal. */
export function isUnderApi(url: string, baseUrl: string): boolean {
	const parsed = parseUrl(url);
	const base = parseUrl(baseUrl);
	if (!parsed || !base) return false;
	if (parsed.protocol !== base.protocol || parsed.host !== base.host) return false;
	if (parsed.username !== '' || parsed.password !== '') return false;
	const prefix = `${base.pathname.replace(/\/+$/, '')}${API_PREFIX}`;
	if (!parsed.pathname.startsWith(prefix)) return false;
	if (/%(2e|2f|5c|25|00)/i.test(parsed.pathname)) return false;
	return hasSafeSegments(parsed.pathname);
}

/**
 * Removes secrets from a message: the given values, bearer tokens, API key headers, password
 * fields and query strings of URLs or paths.
 */
export function redact(text: unknown, secrets: Array<unknown> = []): string {
	let out = typeof text === 'string' ? text : String(text ?? '');
	const values = new Set<string>();
	for (const secret of secrets) {
		if (typeof secret !== 'string') continue;
		for (const value of [secret, secret.trim()]) {
			if (value === '') continue;
			values.add(value);
			values.add(encodeURIComponent(value));
		}
	}
	// Longest first, so a secret that contains another one is removed whole.
	for (const value of [...values].sort((a, b) => b.length - a.length)) {
		out = out.split(value).join(REDACTED);
	}
	if (out.length > MAX_MESSAGE_LENGTH) out = `${out.slice(0, MAX_MESSAGE_LENGTH)}…`;
	out = out.replace(/(bearer\s+)[^\s"',;]+/gi, `$1${REDACTED}`);
	out = out.replace(
		/((?:x-api-key|api[_-]?key|token|password)["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi,
		`$1${REDACTED}`,
	);
	out = out.replace(
		/((?:https?:\/\/[^\s"'?#]*)|(?:\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*))\?[^\s"'#]+/g,
		`$1?${REDACTED}`,
	);
	return out;
}

const PASSWORD_KEY = /password|passwd|secret/i;
const MAX_DEPTH = 20;

function isPasswordKey(key: string): boolean {
	return PASSWORD_KEY.test(key) && !/^has_?password$/i.test(key);
}

/** Returns a copy without any field whose name looks like a password, at any depth. */
export function stripPasswords<T>(value: T, depth = 0): T {
	if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((element) => stripPasswords(element, depth + 1)) as T;
	if (Buffer.isBuffer(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
		if (isPasswordKey(key)) continue;
		Object.defineProperty(out, key, {
			value: stripPasswords(element, depth + 1),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return out as T;
}

/** Collects the string values of password-like fields, at any depth, to redact them from errors. */
export function collectPasswords(value: unknown, found: string[] = [], depth = 0): string[] {
	if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return found;
	for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
		if (isPasswordKey(key) && typeof element === 'string' && element !== '') found.push(element);
		else collectPasswords(element, found, depth + 1);
	}
	return found;
}

/** Keeps only safe characters of a file name suggested by the server. */
export function safeFileName(name: unknown, fallback: string): string {
	if (typeof name !== 'string') return fallback;
	const base = name.split(/[\\/]/).pop() ?? '';
	const cleaned = base
		.replace(/[^A-Za-z0-9._ -]/g, '_')
		.replace(/^\.+/, '')
		.slice(0, 200)
		.trim();
	return cleaned === '' ? fallback : cleaned;
}
