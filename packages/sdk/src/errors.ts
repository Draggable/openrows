/** One problem with the request, as the server names it (`path` is like `records.0.fields`). */
export interface OpenRowsErrorDetail {
  path: string;
  message: string;
}

/**
 * The server refused a request. `type` is Airtable's error type where one fits (`NOT_FOUND`,
 * `INVALID_PERMISSIONS`, `INVALID_FILTER_BY_FORMULA`, `TOO_MANY_REQUESTS`), `code` OpenRows'
 * stable code, `requestId` the id to quote when reporting a problem (also in the server's logs).
 */
export class OpenRowsError extends Error {
  override readonly name = 'OpenRowsError';
  /** The HTTP status: 401, 403, 404, 409, 413, 422, 429 or 5xx. */
  readonly status: number;
  readonly type: string;
  readonly code: string;
  readonly requestId: string | null;
  /** What failed validation, for a 422. */
  readonly errors: OpenRowsErrorDetail[];
  /** For a 429: the bucket that ran out (`base`, `token` or `user`). */
  readonly limit: string | null;
  /** For a 429: seconds the server asked to wait (`Retry-After`). */
  readonly retryAfter: number | null;
  /** The request that failed, like `GET /api/v1/<base>/Tasks`. */
  readonly request: string;

  constructor(init: {
    status: number;
    type: string;
    code: string;
    message: string;
    requestId: string | null;
    request: string;
    errors?: OpenRowsErrorDetail[];
    limit?: string | null;
    retryAfter?: number | null;
  }) {
    super(init.message);
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.requestId = init.requestId;
    this.request = init.request;
    this.errors = init.errors ?? [];
    this.limit = init.limit ?? null;
    this.retryAfter = init.retryAfter ?? null;
  }
}

/** Whether `error` is an `OpenRowsError` (also across copies of the SDK in one bundle). */
export function isOpenRowsError(error: unknown): error is OpenRowsError {
  return error instanceof OpenRowsError || (error as Error | null)?.name === 'OpenRowsError';
}
