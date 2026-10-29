import type { z } from 'zod';

/**
 * Endpoint contracts: each JSON API endpoint is declared once, here in shared, with its
 * method, path, path-parameter, query, body and response schemas. The server registers its
 * handlers from these objects (the RouteRegistry validates requests and parses responses with
 * them), the client's typed API is built from the same objects, and `/api/openapi.json` is
 * generated from them, so the three can't drift apart.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface EndpointDef {
  method: HttpMethod;
  /** Full path, Hono style (`/api/tables/:tableId/records`). */
  path: string;
  /** One line for the OpenAPI document. */
  summary: string;
  /** OpenAPI tag (the resource). */
  tag: string;
  /**
   * Extra checks for some path parameters (each is a string otherwise). A parameter that fails
   * them is answered 404: a malformed id is a resource that doesn't exist.
   */
  params?: Partial<Record<string, z.ZodType<string, string>>>;
  /** Query-string schema (values arrive as strings, so numbers need `z.coerce`). */
  query?: z.ZodType;
  /**
   * The query schema gets every key with all its values (`string[]`), for repeated and
   * bracketed keys (`fields[]=a&fields[]=b`, the REST API v1).
   */
  queryArrays?: true;
  /** JSON body schema. */
  body?: z.ZodType;
  /** Response schema, or `null` for an empty response (204). */
  response: z.ZodType | null;
  /** Success status. */
  status: 200 | 201 | 204;
}

/** Declares an endpoint, keeping its literal types (path, method, schemas). */
export function defineEndpoint<const E extends EndpointDef>(endpoint: E): E {
  if ((endpoint.response === null) !== (endpoint.status === 204)) {
    throw new Error(`${endpoint.method} ${endpoint.path}: only a 204 has no response schema`);
  }
  return endpoint;
}

/** `'/a/:x/b/:y'` → `'x' | 'y'`. */
export type PathParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamNames<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/** The names of a path's parameters, in order. */
export function pathParamNames(path: string): string[] {
  return path
    .split('/')
    .filter((s) => s.startsWith(':'))
    .map((s) => s.slice(1));
}

type ParamsInput<E extends EndpointDef> = [PathParamNames<E['path']>] extends [never]
  ? unknown
  : { params: Record<PathParamNames<E['path']>, string> };

type QueryInput<E extends EndpointDef> = E extends { query: z.ZodType }
  ? { query?: z.input<E['query']> }
  : unknown;

type BodyInput<E extends EndpointDef> = E extends { body: z.ZodType }
  ? { body: z.input<E['body']> }
  : unknown;

/** What a caller passes: `params` (by path), `query`, `body`, when the endpoint has them. */
export type EndpointInput<E extends EndpointDef> = ParamsInput<E> & QueryInput<E> & BodyInput<E>;

/** What the server parsed from a request, after the schemas' defaults and transforms. */
export type EndpointRequest<E extends EndpointDef> = {
  params: Record<PathParamNames<E['path']>, string>;
  query: E extends { query: z.ZodType } ? z.output<E['query']> : undefined;
  body: E extends { body: z.ZodType } ? z.output<E['body']> : undefined;
};

/** The parsed response (`null` for 204). */
export type EndpointOutput<E extends EndpointDef> = E['response'] extends z.ZodType
  ? z.output<E['response']>
  : null;

/** What a server handler returns, before the response schema parses it. */
export type EndpointResult<E extends EndpointDef> = E['response'] extends z.ZodType
  ? z.input<E['response']>
  : null;

type QueryValue = string | number | boolean | null | undefined;

/**
 * The URL path and query string for a call: path parameters are encoded into the path, query
 * values (scalars only) appended, `undefined` and `null` skipped. Throws on a missing parameter.
 */
export function buildUrl(
  endpoint: Pick<EndpointDef, 'method' | 'path'>,
  input: { params?: Record<string, string>; query?: Record<string, QueryValue> } = {}
): string {
  const path = endpoint.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = input.params?.[name];
    if (value === undefined || value === '') {
      throw new Error(`${endpoint.method} ${endpoint.path}: missing path parameter ${name}`);
    }
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null) search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** What a caller sends as the body (before defaults), `never` for endpoints without one. */
export type EndpointBody<E extends EndpointDef> = E extends { body: z.ZodType }
  ? z.input<E['body']>
  : never;
