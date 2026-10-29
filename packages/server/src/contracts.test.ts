import { allEndpoints, downloads } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { testApp } from '../test/helpers/app.js';

/**
 * The contract test: the server serves exactly the endpoints of the shared contracts,
 * which the client's typed API is built from, so server and client can't diverge. Bodies and
 * responses are checked by the contracts' schemas at runtime on both sides.
 */
describe('endpoint contracts', () => {
  const { routes } = testApp();
  const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

  it('registers every shared contract, with the contract itself', () => {
    const served = new Map(routes.entries.filter((e) => e.contract).map((e) => [key(e), e]));
    for (const { name, endpoint } of allEndpoints()) {
      const entry = served.get(key(endpoint));
      expect(entry, `${name} (${key(endpoint)}) is not served`).toBeDefined();
      expect(entry?.contract, name).toBe(endpoint);
    }
    expect(served.size).toBe(allEndpoints().length);
  });

  it('serves no JSON /api route without a contract', () => {
    const without = routes.entries
      .filter((e) => e.path.startsWith('/api/') && !e.contract)
      .map(key);
    // The API description and the file downloads (`downloads`) aren't JSON endpoints, and
    // the billing provider's webhooks read their raw body to check its signature.
    expect(without.sort()).toEqual(
      [
        'GET /api/openapi.json',
        'POST /api/billing/:provider/webhooks',
        ...Object.values(downloads).map(key),
      ].sort()
    );
  });

  it('declares each method and path once', () => {
    const keys = allEndpoints().map((e) => key(e.endpoint));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('GET /api/openapi.json', () => {
  it('describes every contract route, publicly', async () => {
    const { app } = testApp();
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string; responses: object }>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    const ops = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`)
    );
    expect(ops.sort()).toEqual(
      allEndpoints()
        .map((e) => `${e.endpoint.method} ${e.endpoint.path.replace(/:(\w+)/g, '{$1}')}`)
        .sort()
    );
    const ids = Object.values(doc.paths).flatMap((m) => Object.values(m).map((o) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    const list = doc.paths['/api/tables/{tableId}/records'];
    expect(list?.['get']?.responses).toHaveProperty('200');
    expect(list?.['post']?.responses).toHaveProperty('201');
  });
});
