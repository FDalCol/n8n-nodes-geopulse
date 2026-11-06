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

/** Upper bound of pages fetched by one paginated call, so a server that ignores paging cannot loop forever. */
export const MAX_PAGES = 200;

/** Path of the ingestion endpoint that may use the optional GPS source token instead of the API token. */
export const INGEST_PATH = '/api/v1/gps/ingest/home-assistant/batch';

const REDACTED = '[REDACTED]';

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
	if (/%(2e|2f|5c|00)/i.test(path)) {
		throw new Error('Path must not contain encoded dots, slashes or backslashes');
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

/** True when `url` is the Base URL followed by a path under `/api/`, with no traversal. */
export function isUnderApi(url: string, baseUrl: string): boolean {
	const parsed = parseUrl(url);
	const base = parseUrl(baseUrl);
	if (!parsed || !base) return false;
	if (parsed.protocol !== base.protocol || parsed.host !== base.host) return false;
	if (parsed.username !== '' || parsed.password !== '') return false;
	const prefix = `${base.pathname.replace(/\/+$/, '')}${API_PREFIX}`;
	if (!parsed.pathname.startsWith(prefix)) return false;
	return !/%(2e|2f|5c)/i.test(parsed.pathname);
}

/**
 * Removes secrets from a message: the given values, bearer tokens, API key headers, password
 * fields and query strings of URLs or paths.
 */
export function redact(text: unknown, secrets: Array<unknown> = []): string {
	let out = typeof text === 'string' ? text : String(text ?? '');
	for (const secret of secrets) {
		if (typeof secret === 'string' && secret.length >= 4) {
			out = out.split(secret).join(REDACTED);
			const encoded = encodeURIComponent(secret);
			if (encoded !== secret) out = out.split(encoded).join(REDACTED);
		}
	}
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
