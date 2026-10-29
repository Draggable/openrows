import {
  ERROR_CATALOG,
  type ErrorCode,
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  type ProblemFieldError,
  problemType,
} from '@openrows/shared';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import { type AppEnv, loggablePath } from './context.js';

/**
 * Throw this from handlers and services. The global error handler turns it into problem+json
 * with the catalog's status and title. `detail` is shown to the client, so keep it free of
 * internals; anything else goes in `cause`, which is only logged.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly extensions: Record<string, unknown> | undefined;
  /** A status other than the catalog's (QUOTA_EXCEEDED for API calls is a 429). */
  readonly #status: number | undefined;

  constructor(
    code: ErrorCode,
    opts: {
      detail?: string;
      extensions?: Record<string, unknown>;
      cause?: unknown;
      status?: number;
    } = {}
  ) {
    super(opts.detail ?? ERROR_CATALOG[code].title, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.detail = opts.detail;
    this.extensions = opts.extensions;
    this.#status = opts.status;
  }

  get status(): number {
    return this.#status ?? ERROR_CATALOG[this.code].status;
  }
}

/** Builds an RFC 9457 problem+json response carrying the request id. */
export function problem(
  c: Context<AppEnv>,
  code: ErrorCode,
  opts: { detail?: string; extensions?: Record<string, unknown>; status?: number } = {}
): Response {
  const { status, title } = ERROR_CATALOG[code];
  const body: ProblemDetails = {
    type: problemType(code),
    title,
    status: opts.status ?? status,
    ...(opts.detail ? { detail: opts.detail } : {}),
    instance: loggablePath(c.req.path),
    code,
    requestId: c.get('requestId'),
  };
  // Extensions follow the standard members and can never overwrite them.
  for (const [key, value] of Object.entries(opts.extensions ?? {})) {
    if (!(key in body)) body[key] = value;
  }
  return c.body(JSON.stringify(body), body.status as ContentfulStatusCode, {
    'Content-Type': PROBLEM_CONTENT_TYPE,
  });
}

/** The catalog code for an HTTP status (first match), falling back by status class. */
export function codeForStatus(status: number): ErrorCode {
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    if (entry.status === status) return code as ErrorCode;
  }
  return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
}

export function zodFieldErrors(err: ZodError): ProblemFieldError[] {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Global error handler: every error leaves as problem+json; raw messages of 5xx never do. */
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const log = c.get('logger');

  if (err instanceof AppError) {
    if (err.status >= 500) log?.error({ err }, err.message);
    return problem(c, err.code, {
      detail: err.detail,
      extensions: err.extensions,
      status: err.status,
    });
  }
  if (err instanceof ZodError) {
    return problem(c, 'VALIDATION_FAILED', { extensions: { errors: zodFieldErrors(err) } });
  }
  if (err instanceof HTTPException) {
    const status = err.status;
    if (status >= 500) log?.error({ err }, err.message);
    const res = problem(c, codeForStatus(status), {
      status,
      detail: status < 500 && err.message ? err.message : undefined,
    });
    // Keep headers such as WWW-Authenticate that the middleware put on its own response.
    err.res?.headers.forEach((value, key) => {
      if (!/^content-(type|length)$/i.test(key)) res.headers.set(key, value);
    });
    return res;
  }

  log?.error({ err }, 'unhandled error');
  return problem(c, 'INTERNAL_ERROR');
};

export const notFound: NotFoundHandler<AppEnv> = (c) => problem(c, 'NOT_FOUND');
