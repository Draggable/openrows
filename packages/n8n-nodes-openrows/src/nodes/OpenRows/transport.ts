import {
  type IDataObject,
  type IExecuteFunctions,
  type IHookFunctions,
  type IHttpRequestMethods,
  type ILoadOptionsFunctions,
  type JsonObject,
  NodeApiError,
  NodeOperationError,
  sleep,
} from 'n8n-workflow';

export type ApiContext = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions;

export const CREDENTIALS = 'openRowsApi';

/** Records per write request and per page: the REST API's limits (`V1_BATCH_MAX`, page size). */
export const BATCH_SIZE = 10;
export const PAGE_SIZE = 100;

/** Times a request refused with 429 is sent again, after its `Retry-After`. */
export const MAX_RETRIES = 3;
/** The longest `Retry-After` the nodes wait for; a longer one fails the request instead. */
export const MAX_RETRY_WAIT_SECONDS = 30;

interface FullResponse {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  statusCode: number;
}

/** The credential's server URL without trailing slashes; only http(s). */
export function serverUrl(ctx: ApiContext, value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    throw new NodeOperationError(ctx.getNode(), 'The OpenRows credential needs an http(s) URL', {
      description: 'Set "Server URL" to your server, e.g. https://app.openrows.io',
    });
  }
  return raw;
}

/** One path segment (an id or a table name). */
export const seg = (value: string) => encodeURIComponent(value);

function header(headers: FullResponse['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** The API's `{ error: { type, message, code } }`, as n8n shows it. */
function apiError(ctx: ApiContext, res: FullResponse, itemIndex?: number): NodeApiError {
  const body = parseBody(res.body);
  const error =
    body &&
    typeof body === 'object' &&
    'error' in body &&
    body.error &&
    typeof body.error === 'object'
      ? (body.error as IDataObject)
      : {};
  const message = typeof error['message'] === 'string' ? error['message'] : undefined;
  const code = typeof error['code'] === 'string' ? error['code'] : error['type'];
  const requestId = typeof error['requestId'] === 'string' ? error['requestId'] : undefined;
  const details = [
    typeof code === 'string' ? `Code: ${code}` : undefined,
    requestId ? `Request id: ${requestId}` : undefined,
  ].filter(Boolean);
  // Only the API's answer goes into the error, never the request (its headers hold the token).
  return new NodeApiError(ctx.getNode(), { error } as JsonObject, {
    httpCode: String(res.statusCode),
    message: message ?? `OpenRows answered ${res.statusCode}`,
    description: details.length ? details.join('. ') : undefined,
    itemIndex,
  });
}

export interface RequestOptions {
  body?: IDataObject;
  /** Query string, already encoded (`records[]=…&records[]=…`). */
  query?: string;
  itemIndex?: number;
}

/**
 * One call of the REST API v1 with the credential's token, from `path` (under `/api/v1`). A 429
 * is sent again after `Retry-After` (at most `MAX_RETRIES` times, waits up to
 * `MAX_RETRY_WAIT_SECONDS`); other refusals throw a NodeApiError with the API's message, code and
 * request id.
 */
export async function apiRequest<T = IDataObject>(
  ctx: ApiContext,
  method: IHttpRequestMethods,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const credentials = await ctx.getCredentials(CREDENTIALS);
  const base = serverUrl(ctx, credentials['baseUrl']);
  const url = `${base}/api/v1${path}${options.query ? `?${options.query}` : ''}`;
  for (let attempt = 0; ; attempt++) {
    const res = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIALS, {
      method,
      url,
      body: options.body,
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      disableFollowRedirect: true,
    })) as FullResponse;
    if (res.statusCode < 400) return parseBody(res.body) as T;
    const retryAfter = Number(header(res.headers, 'retry-after'));
    if (
      res.statusCode === 429 &&
      attempt < MAX_RETRIES &&
      Number.isFinite(retryAfter) &&
      retryAfter >= 0 &&
      retryAfter <= MAX_RETRY_WAIT_SECONDS
    ) {
      await sleep(retryAfter * 1000);
      continue;
    }
    throw apiError(ctx, res, options.itemIndex);
  }
}

/** A list of ids as the API's `records[]=` query. */
export function recordsQuery(ids: readonly string[]): string {
  return ids.map((id) => `records[]=${encodeURIComponent(id)}`).join('&');
}
