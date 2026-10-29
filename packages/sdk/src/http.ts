import { OpenRowsError, type OpenRowsErrorDetail } from './errors.js';

/** An endpoint of `V1_ENDPOINTS`, like `V1_ENDPOINTS.v1Records.list`. */
export interface Endpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  status: number;
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** A personal access token (`or_pat_…`). Leave it out in a browser signed in to the same app. */
  apiKey?: string;
  /** The app's origin, e.g. `https://app.openrows.io` (the default) or your own server's. */
  baseUrl?: string;
  /** How many times to retry a request answered 429, after its `Retry-After` (default 3). */
  maxRetries?: number;
  /** The longest `Retry-After` to wait, in ms; a longer one fails at once (default 60 s). */
  maxRetryDelay?: number;
  /** Per-request timeout in ms (default 60 s; 0 for none). */
  timeout?: number;
  /** A `fetch` to use instead of the global one. */
  fetch?: Fetch;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
}

export interface CallInput {
  params?: Record<string, string>;
  /** Query values; arrays repeat the key (`records[]=a&records[]=b`). */
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  body?: unknown;
}

export const DEFAULT_BASE_URL = 'https://app.openrows.io';

/** `Retry-After` in ms: delta-seconds or an HTTP date; `null` when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** The origin with no trailing slash (also accepts `<origin>/api` and `<origin>/api/v1`). */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
}

export function buildPath(endpoint: Endpoint, input: CallInput): string {
  const path = endpoint.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = input.params?.[name];
    if (value === undefined || value === '') throw new TypeError(`Missing path parameter ${name}`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(input.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) search.append(k, String(item));
    else search.append(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sends the SDK's requests: the token, JSON, 429 retries and errors as `OpenRowsError`. */
export class HttpClient {
  readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly headers: Record<string, string>;
  private readonly maxRetries: number;
  private readonly maxRetryDelay: number;
  private readonly timeout: number;
  /** Waits between retries (replaced in tests). */
  sleep: (ms: number) => Promise<void> = sleep;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    if (!options.fetch && typeof globalThis.fetch !== 'function') {
      throw new TypeError('No global fetch: pass one in the options.');
    }
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.headers = { Accept: 'application/json', ...options.headers };
    if (options.apiKey) this.headers['Authorization'] = `Bearer ${options.apiKey}`;
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.maxRetryDelay = options.maxRetryDelay ?? 60_000;
    this.timeout = options.timeout ?? 60_000;
  }

  async call<T>(endpoint: Endpoint, input: CallInput = {}): Promise<T> {
    const path = buildPath(endpoint, input);
    const request = `${endpoint.method} ${path.split('?')[0]}`;
    const headers: Record<string, string> = { ...this.headers };
    let body: string | undefined;
    if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(input.body);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method: endpoint.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(this.timeout > 0 && typeof AbortSignal?.timeout === 'function'
          ? { signal: AbortSignal.timeout(this.timeout) }
          : {}),
      });
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const error = await toError(res, request);
      if (res.status === 429 && attempt < this.maxRetries) {
        // Without Retry-After: 1 s, 2 s, 4 s… A wait past maxRetryDelay fails now instead.
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt;
        if (wait <= this.maxRetryDelay) {
          await this.sleep(wait);
          continue;
        }
      }
      throw error;
    }
  }
}

async function toError(res: Response, request: string): Promise<OpenRowsError> {
  const text = await res.text().catch(() => '');
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy's error page): described by the status alone.
  }
  // v1 answers `{ error: { type, message, code, requestId } }`; other routes problem+json.
  const e = (body['error'] && typeof body['error'] === 'object' ? body['error'] : body) as Record<
    string,
    unknown
  >;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const retryAfter = retryAfterMs(res.headers.get('retry-after'));
  const fallback = res.status === 429 ? 'TOO_MANY_REQUESTS' : `HTTP_${res.status}`;
  return new OpenRowsError({
    status: res.status,
    type: str(e['type']) ?? str(e['code']) ?? fallback,
    code: str(e['code']) ?? str(e['type']) ?? fallback,
    message:
      str(e['message']) ?? str(e['detail']) ?? str(e['title']) ?? `${request}: HTTP ${res.status}`,
    requestId: str(e['requestId']) ?? res.headers.get('x-request-id'),
    request,
    errors: Array.isArray(e['errors']) ? (e['errors'] as OpenRowsErrorDetail[]) : [],
    limit: str(e['limit']),
    retryAfter: retryAfter === null ? null : retryAfter / 1000,
  });
}
