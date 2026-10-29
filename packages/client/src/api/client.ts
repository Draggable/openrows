import {
  type ApiClient,
  type ApiRequest,
  type AttachmentUpload,
  adminContracts,
  auditContracts,
  buildUrl,
  ContractMismatchError,
  contracts,
  createApiClient,
  ERROR_CODES,
  type ErrorCode,
  OPENAPI_PATH,
  ProblemDetailsSchema,
  scimContracts,
  ssoContracts,
  workspaceAdminContracts,
} from '@openrows/shared';

/**
 * The typed API: one function per endpoint contract in `@openrows/shared`
 * (`api.records.list({ params: { tableId }, query: { limit } })`). URLs, methods and response
 * schemas come from the contracts the server registers its routes with, so the client can't
 * call a path the server doesn't serve or read a field it doesn't send. This module is the only
 * place in the client that calls `fetch` for the API.
 */

/** Origin of the API (contract paths start with `/api`). Same origin by default. */
const API_ORIGIN = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly data?: unknown,
    /** Stable code from the server's error catalog (problem+json), when it sent one. */
    public readonly code?: ErrorCode,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The REST API v1's error body, or undefined. */
function v1Error(
  data: unknown
): { message: string; code?: ErrorCode; requestId?: string } | undefined {
  if (typeof data !== 'object' || data === null || !('error' in data)) return undefined;
  const error: unknown = data.error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { message, code, requestId } = error as Record<string, unknown>;
  if (typeof message !== 'string') return undefined;
  return {
    message,
    ...(typeof code === 'string' && (ERROR_CODES as string[]).includes(code)
      ? { code: code as ErrorCode }
      : {}),
    ...(typeof requestId === 'string' ? { requestId } : {}),
  };
}

/** Sends one contract request with the session cookie; non-2xx answers throw `ApiError`. */
export async function fetchTransport({ method, url, body }: ApiRequest) {
  const response = await fetch(`${API_ORIGIN}${url}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = parseJson(await response.text());

  if (!response.ok) {
    // Every server error is RFC 9457 problem+json; anything else (e.g. a proxy page) is generic.
    const problem = ProblemDetailsSchema.safeParse(data);
    if (problem.success) {
      const { detail, title, code, requestId } = problem.data;
      throw new ApiError(response.status, detail ?? title, data, code, requestId);
    }
    // The REST API v1 answers `{ error: { type, message, code, requestId } }`; the app
    // calls it for webhooks.
    const v1 = v1Error(data);
    if (v1) throw new ApiError(response.status, v1.message, data, v1.code, v1.requestId);
    throw new ApiError(response.status, `Request failed with status ${response.status}`, data);
  }
  return { status: response.status, data };
}

/**
 * GET one of the server's non-API JSON routes (the BFF's `/auth/*`, e.g. `/auth/providers`),
 * which have no contract. Returns undefined on any failure: callers treat it as optional.
 */
export async function fetchAuthJson(path: `/auth/${string}`): Promise<unknown> {
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, { credentials: 'include' });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server's OpenAPI document (`OPENAPI_PATH`), for the API reference page. Not a
 * contract route: it describes them. Public, so no cookie goes along.
 */
export async function fetchOpenApiDocument(): Promise<unknown> {
  const response = await fetch(`${API_ORIGIN}${OPENAPI_PATH}`);
  if (!response.ok) {
    throw new ApiError(response.status, `Request failed with status ${response.status}`, null);
  }
  return response.json();
}

/**
 * The URL of a file download (`downloads` in @openrows/shared, e.g. the CSV export), for a
 * link the browser follows: the server streams the file and the browser saves it.
 */
export function downloadUrl(
  endpoint: { method: 'GET'; path: string },
  input: { params: Record<string, string>; query?: Record<string, string | undefined> }
): string {
  return `${API_ORIGIN}${buildUrl(endpoint, input)}`;
}

/**
 * PUTs a file's bytes to the presigned storage URL the API answered for it. Not an API
 * call (the URL points at object storage), so it isn't in the contracts; no cookies go along.
 */
export async function putToStorage(upload: AttachmentUpload['upload'], file: Blob): Promise<void> {
  const res = await fetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: file,
    credentials: 'omit',
  });
  if (!res.ok) throw new ApiError(res.status, `The upload failed (${res.status}).`);
}

// Annotated: the inferred type of every contract is past what declaration emit serializes.
const raw: ApiClient<typeof contracts> = createApiClient(contracts, fetchTransport);

/** A contract mismatch (wrong status or body) surfaces as an `ApiError` too. */
function wrap<F extends (...args: never[]) => Promise<unknown>>(fn: F): F {
  return (async (...args: Parameters<F>) => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof ContractMismatchError) {
        throw new ApiError(err.status, err.message, err.issues);
      }
      throw err;
    }
  }) as F;
}

export const api = Object.fromEntries(
  Object.entries(raw).map(([resource, calls]) => [
    resource,
    Object.fromEntries(Object.entries(calls).map(([name, fn]) => [name, wrap(fn)])),
  ])
) as typeof raw;

/**
 * The hosted ops console's endpoints (`/admin`): only the hosted edition serves them, to
 * system admins with a recent sign-in, and everyone else gets 404.
 */
const rawAdmin = createApiClient(adminContracts, fetchTransport);
export const adminApi = Object.fromEntries(
  Object.entries(rawAdmin).map(([resource, calls]) => [
    resource,
    Object.fromEntries(Object.entries(calls).map(([name, fn]) => [name, wrap(fn)])),
  ])
) as typeof rawAdmin;

/**
 * The workspace audit log's endpoints (`/w/:workspaceId/audit-log`): only the hosted
 * edition serves them (404 elsewhere), to owners on a plan with the audit log (403
 * PLAN_FEATURE_REQUIRED on others).
 */
const rawAudit = createApiClient(auditContracts, fetchTransport);
export const auditApi = Object.fromEntries(
  Object.entries(rawAudit).map(([resource, calls]) => [
    resource,
    Object.fromEntries(Object.entries(calls).map(([name, fn]) => [name, wrap(fn)])),
  ])
) as typeof rawAudit;

/**
 * Per-workspace single sign-on's endpoints (`/w/:workspaceId/sso`): only the hosted
 * edition serves them (404 elsewhere), to owners on a plan with `sso` (403 PLAN_FEATURE_REQUIRED
 * on others).
 */
const rawSso = createApiClient(ssoContracts, fetchTransport);
export const ssoApi = Object.fromEntries(
  Object.entries(rawSso).map(([resource, calls]) => [
    resource,
    Object.fromEntries(Object.entries(calls).map(([name, fn]) => [name, wrap(fn)])),
  ])
) as typeof rawSso;

/**
 * SCIM provisioning's settings (on `/w/:workspaceId/sso`): only the hosted edition serves
 * them (404 elsewhere), to owners on a plan with `scim` (403 PLAN_FEATURE_REQUIRED on others).
 */
const rawScim = createApiClient(scimContracts, fetchTransport);
export const scimApi = Object.fromEntries(
  Object.entries(rawScim).map(([resource, calls]) => [
    resource,
    Object.fromEntries(Object.entries(calls).map(([name, fn]) => [name, wrap(fn)])),
  ])
) as typeof rawScim;

/**
 * The workspace admin console's endpoints (`/w/:workspaceId/admin`): only the hosted
 * edition serves them (404 elsewhere), to owners; the member list needs a plan with the admin
 * console (403 PLAN_FEATURE_REQUIRED on others).
 */
const rawWorkspaceAdmin = createApiClient(workspaceAdminContracts, fetchTransport);
export const workspaceAdminApi = Object.fromEntries(
  Object.entries(rawWorkspaceAdmin).map(([resource, calls]) => [
    resource,
    Object.fromEntries(Object.entries(calls).map(([name, fn]) => [name, wrap(fn)])),
  ])
) as typeof rawWorkspaceAdmin;
