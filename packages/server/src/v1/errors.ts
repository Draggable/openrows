import { type ErrorCode, PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@openrows/shared';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../lib/context.js';

/** Airtable's error type for each of our codes where one fits; the rest keep our code. */
const AIRTABLE_TYPES: Partial<Record<ErrorCode, string>> = {
  BAD_REQUEST: 'INVALID_REQUEST_UNKNOWN',
  VALIDATION_FAILED: 'INVALID_REQUEST_UNKNOWN',
  TYPECAST_FORBIDDEN: 'INVALID_MULTIPLE_CHOICE_OPTIONS',
  UNAUTHENTICATED: 'AUTHENTICATION_REQUIRED',
  FORBIDDEN: 'INVALID_PERMISSIONS',
  EDIT_RESTRICTED: 'INVALID_PERMISSIONS',
  NOT_FOUND: 'NOT_FOUND',
  PAYLOAD_TOO_LARGE: 'REQUEST_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'INVALID_REQUEST_UNKNOWN',
  RATE_LIMITED: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'SERVER_ERROR',
};

const STANDARD = new Set(['type', 'title', 'status', 'detail', 'instance', 'code', 'requestId']);

/**
 * The REST API v1's errors in Airtable's shape: `{ error: { type, message, code,
 * requestId, ... } }` with our status codes, made from the problem+json every error handler
 * answers, so a v1 route throws `AppError` like any other.
 */
export const v1Errors: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (!c.res.headers.get('content-type')?.startsWith(PROBLEM_CONTENT_TYPE)) return;
  const problem = (await c.res.clone().json()) as ProblemDetails;
  const extensions = Object.fromEntries(Object.entries(problem).filter(([k]) => !STANDARD.has(k)));
  const body = {
    error: {
      type: AIRTABLE_TYPES[problem.code] ?? problem.code,
      message: problem.detail ?? problem.title,
      code: problem.code,
      requestId: problem.requestId,
      ...extensions,
    },
  };
  const { status } = c.res;
  const headers = new Headers(c.res.headers);
  headers.set('content-type', 'application/json; charset=UTF-8');
  headers.delete('content-length');
  // Replacing c.res would merge the old headers back in; a fresh response keeps these only.
  c.res = undefined;
  c.res = new Response(JSON.stringify(body), { status, headers });
};
