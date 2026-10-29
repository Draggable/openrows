import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  type ApiRequest,
  allEndpoints,
  buildOpenApiDocument,
  buildUrl,
  ContractMismatchError,
  contracts,
  createApiClient,
  defineEndpoint,
  type PathParamNames,
  pathParamNames,
} from './index.js';

const TABLE = '0190a000-0000-7000-8000-000000000001';
const RECORD = '0190a000-0000-7000-8000-000000000002';
const NOW = '2026-10-25T10:00:00.000Z';

const record = {
  id: RECORD,
  tableId: TABLE,
  version: 2,
  fields: {},
  createdAt: NOW,
  createdBy: null,
  updatedAt: NOW,
  updatedBy: null,
};

describe('contracts', () => {
  it('all live under /api, with unique method + path and a matching status', () => {
    const keys = allEndpoints().map(({ endpoint: e }) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const { name, endpoint: e } of allEndpoints()) {
      expect(e.path, name).toMatch(/^\/api\//);
      expect(e.response === null, name).toBe(e.status === 204);
      for (const p of Object.keys(e.params ?? {}))
        expect(pathParamNames(e.path), name).toContain(p);
      if (e.method === 'GET' || e.method === 'DELETE') expect(e.body, name).toBeUndefined();
    }
  });

  it('refuses a 204 with a body schema, or a body status without one', () => {
    const base = { method: 'GET', path: '/api/x', summary: 'x', tag: 'x' } as const;
    expect(() => defineEndpoint({ ...base, response: z.object({}), status: 204 })).toThrow();
    expect(() => defineEndpoint({ ...base, response: null, status: 200 })).toThrow();
  });

  it('types path parameters from the path', () => {
    expectTypeOf<PathParamNames<'/api/tables/:tableId/records/:recordId'>>().toEqualTypeOf<
      'tableId' | 'recordId'
    >();
    expectTypeOf<PathParamNames<'/api/me'>>().toBeNever();
  });
});

describe('buildUrl', () => {
  it('fills and encodes path parameters and appends defined query values', () => {
    expect(
      buildUrl(contracts.records.list, {
        params: { tableId: 'a b/c' },
        query: { limit: 5, cursor: undefined, x: null },
      })
    ).toBe('/api/tables/a%20b%2Fc/records?limit=5');
    expect(buildUrl(contracts.me.get)).toBe('/api/me');
  });

  it('throws on a missing parameter rather than calling a wrong URL', () => {
    expect(() => buildUrl(contracts.records.get, { params: { tableId: TABLE } })).toThrow(
      /missing path parameter recordId/
    );
  });
});

describe('createApiClient', () => {
  function fakeServer(answer: { status: number; data: unknown }) {
    const sent: ApiRequest[] = [];
    const api = createApiClient(contracts, async (req) => {
      sent.push(req);
      return answer;
    });
    return { api, sent };
  }

  it('sends method, URL and body from the contract and parses the response', async () => {
    const { api, sent } = fakeServer({ status: 200, data: record });
    const out = await api.records.update({
      params: { tableId: TABLE, recordId: RECORD },
      body: { fields: { [RECORD]: 'x' }, ifVersion: 1 },
    });
    expect(out.version).toBe(2);
    expectTypeOf(out.version).toEqualTypeOf<number>();
    expect(sent).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        url: `/api/tables/${TABLE}/records/${RECORD}`,
        body: { fields: { [RECORD]: 'x' }, ifVersion: 1 },
      }),
    ]);
  });

  it('calls endpoints without input, and 204s answer null', async () => {
    const { api, sent } = fakeServer({ status: 204, data: undefined });
    expect(await api.bases.delete({ params: { baseId: TABLE } })).toBeNull();
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.body).toBeUndefined();
  });

  it('rejects a response that breaks the contract', async () => {
    const { api } = fakeServer({ status: 200, data: { records: 'nope' } });
    await expect(api.records.list({ params: { tableId: TABLE } })).rejects.toBeInstanceOf(
      ContractMismatchError
    );
  });

  it('rejects an unexpected success status', async () => {
    const { api } = fakeServer({ status: 200, data: record });
    await expect(
      api.records.create({ params: { tableId: TABLE }, body: { fields: {} } })
    ).rejects.toThrow(/status 200/);
  });
});

describe('buildOpenApiDocument', () => {
  const doc = buildOpenApiDocument(
    allEndpoints().map(({ endpoint }) => ({ endpoint, access: 'test', kind: 'resource' })),
    { title: 'T', version: '1', sessionCookie: 'sid', serverUrl: 'https://example.org' }
  );

  it('has one operation per contract with unique operation ids', () => {
    const ops = Object.values(doc.paths).flatMap((m) => Object.values(m)) as {
      operationId: string;
    }[];
    expect(ops).toHaveLength(allEndpoints().length);
    expect(new Set(ops.map((o) => o.operationId)).size).toBe(ops.length);
  });

  it('documents path and query parameters, bodies and responses', () => {
    const list = doc.paths['/api/tables/{tableId}/records']?.['get'] as {
      parameters: { name: string; in: string }[];
      responses: Record<string, unknown>;
    };
    expect(list.parameters.map((p) => `${p.in}:${p.name}`)).toEqual([
      'path:tableId',
      'query:limit',
      'query:cursor',
    ]);
    expect(Object.keys(list.responses)).toEqual(expect.arrayContaining(['200', '401', '404']));
    const create = doc.paths['/api/tables/{tableId}/records']?.['post'] as {
      requestBody: { content: { 'application/json': { schema: object } } };
    };
    expect(create.requestBody.content['application/json'].schema).toHaveProperty('anyOf');
    expect(JSON.stringify(doc)).not.toContain('$defs');
  });

  it('documents the 429 of the rate limits, the server and the license (#104)', () => {
    const list = doc.paths['/api/tables/{tableId}/records']?.['get'] as {
      responses: Record<string, { headers?: Record<string, unknown> }>;
    };
    expect(Object.keys(list.responses['429']?.headers ?? {})).toEqual([
      'Retry-After',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
    ]);
    expect(doc.servers).toEqual([{ url: 'https://example.org' }]);
    expect(doc.info.license).toEqual({ name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' });
  });
});
