import type { z } from 'zod';
import {
  buildUrl,
  type EndpointDef,
  type EndpointInput,
  type EndpointOutput,
  type HttpMethod,
} from './endpoint.js';

/** One HTTP call, ready to send. */
export interface ApiRequest {
  endpoint: EndpointDef;
  method: HttpMethod;
  /** Path and query string, e.g. `/api/tables/<id>/records?limit=50`. */
  url: string;
  /** JSON body, when the endpoint takes one. */
  body?: unknown;
}

/**
 * Sends a request and answers its status and parsed JSON (`undefined` when empty). It throws
 * for non-2xx responses (the browser client turns problem+json into `ApiError`).
 */
export type Transport = (request: ApiRequest) => Promise<{ status: number; data: unknown }>;

/** The server answered a 2xx that doesn't match the contract (wrong status or body). */
export class ContractMismatchError extends Error {
  constructor(
    readonly endpoint: EndpointDef,
    readonly status: number,
    readonly issues?: z.ZodError
  ) {
    super(`Unexpected response from ${endpoint.method} ${endpoint.path} (status ${status})`);
    this.name = 'ContractMismatchError';
  }
}

/** A typed function per endpoint: input from the contract's params/query/body, parsed output. */
export type EndpointCall<E extends EndpointDef> = keyof EndpointInput<E> extends never
  ? (input?: EndpointInput<E>) => Promise<EndpointOutput<E>>
  : (input: EndpointInput<E>) => Promise<EndpointOutput<E>>;

export type ApiClient<T extends Record<string, Record<string, EndpointDef>>> = {
  [R in keyof T]: { [N in keyof T[R]]: EndpointCall<T[R][N]> };
};

interface CallInput {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
}

/** Calls one endpoint through `send` and checks the answer against the contract. */
export async function callEndpoint<E extends EndpointDef>(
  endpoint: E,
  input: EndpointInput<E> | undefined,
  send: Transport
): Promise<EndpointOutput<E>> {
  const { params, query, body } = (input ?? {}) as CallInput;
  const { status, data } = await send({
    endpoint,
    method: endpoint.method,
    url: buildUrl(endpoint, { params, query }),
    body: endpoint.body ? body : undefined,
  });
  if (status !== endpoint.status) throw new ContractMismatchError(endpoint, status);
  if (endpoint.response === null) return null as EndpointOutput<E>;
  const parsed = endpoint.response.safeParse(data);
  if (!parsed.success) throw new ContractMismatchError(endpoint, status, parsed.error);
  return parsed.data as EndpointOutput<E>;
}

/** The typed API (`api.records.list({ params: { tableId } })`) for a tree of contracts. */
export function createApiClient<T extends Record<string, Record<string, EndpointDef>>>(
  tree: T,
  send: Transport
): ApiClient<T> {
  return Object.fromEntries(
    Object.entries(tree).map(([resource, group]) => [
      resource,
      Object.fromEntries(
        Object.entries(group).map(([name, endpoint]) => [
          name,
          (input?: EndpointInput<typeof endpoint>) => callEndpoint(endpoint, input, send),
        ])
      ),
    ])
  ) as ApiClient<T>;
}
