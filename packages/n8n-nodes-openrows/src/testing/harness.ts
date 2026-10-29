import type {
  ICredentialDataDecryptedObject,
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  INode,
  INodeExecutionData,
  IWebhookFunctions,
} from 'n8n-workflow';
import { OpenRowsApi } from '../credentials/OpenRowsApi.credentials';

/**
 * Test helpers, built to dist/testing for the server's integration test and left out of the npm
 * package. n8n's node test harness (NodeTestHarness, in n8n's monorepo) isn't published, so these are the
 * function contexts n8n hands a node, as n8n's own unit tests mock them: parameters by (dotted)
 * name with resource locators' `extractValue`, the input items, `continueOnFail`, workflow static
 * data, and `httpRequestWithAuthentication` sending real HTTP with the credential's
 * `authenticate` rule applied, the way n8n applies it.
 */

export const NODE: INode = {
  id: 'node-1',
  name: 'OpenRows',
  type: '@openrows/n8n-nodes-openrows.openRows',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

type Params = Record<string, unknown>;
type ParamsFor = Params | ((itemIndex: number) => Params);

/** Evaluates n8n's `={{ … }}` credential expressions against the credential's values. */
export function resolveExpression(value: string, credentials: ICredentialDataDecryptedObject) {
  if (!value.startsWith('=')) return value;
  return value
    .slice(1)
    .replace(/\{\{(.+?)\}\}/g, (_, expr: string) =>
      String(new Function('$credentials', `return (${expr});`)(credentials))
    );
}

/** A resource locator value, as n8n stores one. */
export const rl = (value: string, mode = 'list') => ({ __rl: true, mode, value });

function pick(params: Params, path: string): unknown {
  let at: unknown = params;
  for (const key of path.split('.')) {
    if (!at || typeof at !== 'object') return undefined;
    at = (at as Params)[key];
  }
  return at;
}

function parameter(
  params: Params,
  name: string,
  fallback: unknown,
  options?: { extractValue?: boolean }
): unknown {
  let value = pick(params, name);
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`Could not get parameter "${name}"`);
    value = fallback;
  }
  if (options?.extractValue && value && typeof value === 'object' && '__rl' in value) {
    return (value as unknown as { value: unknown }).value;
  }
  return value;
}

export interface Sent {
  method: string;
  url: string;
}

/** `httpRequestWithAuthentication` over fetch, with the credential's bearer header. */
export function httpHelper(credentials: ICredentialDataDecryptedObject, sent: Sent[] = []) {
  const auth = new OpenRowsApi().authenticate;
  return async (type: string, opts: IHttpRequestOptions) => {
    if (type !== 'openRowsApi') throw new Error(`unexpected credential ${type}`);
    const headers: Record<string, string> = { accept: 'application/json' };
    for (const [key, value] of Object.entries(auth.properties.headers ?? {})) {
      headers[key] = resolveExpression(String(value), credentials);
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const url = opts.baseURL ? `${opts.baseURL}${opts.url}` : opts.url;
    sent.push({ method: opts.method ?? 'GET', url });
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      redirect: opts.disableFollowRedirect ? 'manual' : 'follow',
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : '';
    } catch {
      body = text;
    }
    if (!opts.ignoreHttpStatusErrors && res.status >= 400) {
      throw new Error(`Request failed with status code ${res.status}`);
    }
    if (!opts.returnFullResponse) return body;
    return { body, headers: Object.fromEntries(res.headers), statusCode: res.status };
  };
}

interface ContextOptions {
  params: ParamsFor;
  credentials: ICredentialDataDecryptedObject;
  sent?: Sent[];
}

function base({ params, credentials, sent }: ContextOptions) {
  const of = (i: number) => (typeof params === 'function' ? params(i) : params);
  return {
    of,
    context: {
      getNode: () => NODE,
      getCredentials: async (type: string) => {
        if (type !== 'openRowsApi') throw new Error(`unexpected credential ${type}`);
        return credentials;
      },
      helpers: { httpRequestWithAuthentication: httpHelper(credentials, sent) },
    },
  };
}

/** An `IExecuteFunctions` for `execute()`. */
export function executeContext(
  opts: ContextOptions & { items?: INodeExecutionData[]; continueOnFail?: boolean }
): IExecuteFunctions {
  const { of, context } = base(opts);
  const items = opts.items ?? [{ json: {} }];
  return {
    ...context,
    getInputData: () => items,
    continueOnFail: () => opts.continueOnFail ?? false,
    getNodeParameter: (
      name: string,
      i: number,
      fallback?: unknown,
      o?: { extractValue?: boolean }
    ) => parameter(of(i), name, fallback, o),
  } as unknown as IExecuteFunctions;
}

/** An `ILoadOptionsFunctions` for list searches, option loaders and the column mapper. */
export function loadOptionsContext(opts: ContextOptions): ILoadOptionsFunctions {
  const { of, context } = base(opts);
  return {
    ...context,
    getNodeParameter: (name: string, fallback?: unknown, o?: { extractValue?: boolean }) =>
      parameter(of(0), name, fallback, o),
  } as unknown as ILoadOptionsFunctions;
}

/** An `IHookFunctions` for a trigger's webhook methods (activate, deactivate). */
export function hookContext(
  opts: ContextOptions & { staticData: IDataObject; webhookUrl: string; workflowName?: string }
): IHookFunctions {
  const { of, context } = base(opts);
  return {
    ...context,
    getNodeWebhookUrl: () => opts.webhookUrl,
    getWorkflow: () => ({ id: 'wf-1', name: opts.workflowName ?? 'Sync tasks', active: true }),
    getWorkflowStaticData: () => opts.staticData,
    getNodeParameter: (name: string, fallback?: unknown, o?: { extractValue?: boolean }) =>
      parameter(of(0), name, fallback, o),
  } as unknown as IHookFunctions;
}

export interface Responded {
  status?: number;
  body?: unknown;
}

/** An `IWebhookFunctions` for a delivery: its raw body and headers; what was answered. */
export function webhookContext(opts: {
  params: Params;
  staticData: IDataObject;
  rawBody: Buffer | undefined;
  headers: Record<string, string>;
}): { context: IWebhookFunctions; responded: Responded } {
  const responded: Responded = {};
  const response = {
    status(code: number) {
      responded.status = code;
      return response;
    },
    send(body: unknown) {
      responded.body = body;
      return response;
    },
  };
  const context = {
    getNode: () => NODE,
    getWorkflowStaticData: () => opts.staticData,
    getRequestObject: () => ({ rawBody: opts.rawBody, headers: opts.headers }),
    getHeaderData: () => opts.headers,
    getResponseObject: () => response,
    getNodeParameter: (name: string, fallback?: unknown) => parameter(opts.params, name, fallback),
  } as unknown as IWebhookFunctions;
  return { context, responded };
}
