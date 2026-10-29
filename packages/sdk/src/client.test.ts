import { describe, expect, it } from 'vitest';
import { chunks, OpenRows } from './client.js';
import { isOpenRowsError, OpenRowsError } from './errors.js';
import { normalizeBaseUrl, retryAfterMs } from './http.js';

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const BASE = '0190a000-0000-7000-8000-000000000001';

/** A fake `fetch` answering from `reply` and recording each request. */
function fakeFetch(reply: (req: Sent, n: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const req: Sent = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    sent.push(req);
    return reply(req, sent.length);
  };
  return { sent, fetch };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const record = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  createdTime: '2026-10-27T00:00:00.000Z',
  fields,
});

function client(reply: Parameters<typeof fakeFetch>[0], options = {}) {
  const f = fakeFetch(reply);
  const openrows = new OpenRows({
    apiKey: 'or_pat_test',
    baseUrl: 'https://rows.example.com/',
    fetch: f.fetch,
    ...options,
  });
  const waits: number[] = [];
  openrows.http.sleep = async (ms) => {
    waits.push(ms);
  };
  return { openrows, sent: f.sent, waits };
}

describe('OpenRows', () => {
  it('sends the token and JSON to the base URL', async () => {
    const { openrows, sent } = client(() =>
      json({ bases: [{ id: BASE, name: 'Roadmap', permissionLevel: 'owner' }] })
    );
    expect(await openrows.bases.list()).toEqual([
      { id: BASE, name: 'Roadmap', permissionLevel: 'owner' },
    ]);
    expect(sent[0]).toMatchObject({
      method: 'GET',
      url: 'https://rows.example.com/api/v1/meta/bases',
      headers: { Authorization: 'Bearer or_pat_test', Accept: 'application/json' },
    });
  });

  it('pages through select() with the offset, in the body', async () => {
    const { openrows, sent } = client((req) =>
      json(
        (req.body as { offset?: string }).offset === 'next'
          ? { records: [record('c')] }
          : { records: [record('a'), record('b')], offset: 'next' }
      )
    );
    const tasks = openrows.table(BASE, 'My Tasks');
    const query = tasks.select({ pageSize: 2, view: 'Grid', fields: ['Name'] });
    expect((await query.all()).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      [
        'POST',
        `https://rows.example.com/api/v1/${BASE}/My%20Tasks/listRecords`,
        { pageSize: 2, view: 'Grid', fields: ['Name'] },
      ],
      [
        'POST',
        `https://rows.example.com/api/v1/${BASE}/My%20Tasks/listRecords`,
        { pageSize: 2, view: 'Grid', fields: ['Name'], offset: 'next' },
      ],
    ]);

    const pages: string[][] = [];
    await query.eachPage((records) => {
      pages.push(records.map((r) => r.id));
      return false;
    });
    expect(pages).toEqual([['a', 'b']]);
    const iterated: string[] = [];
    for await (const r of query) iterated.push(r.id);
    expect(iterated).toEqual(['a', 'b', 'c']);
  });

  it('creates, updates, replaces and deletes in batches of 10, in order', async () => {
    const { openrows, sent } = client((req) => {
      const body = req.body as
        | { records?: { id?: string; fields: Record<string, unknown> }[] }
        | undefined;
      if (req.method === 'DELETE') {
        const ids = new URL(req.url).searchParams.getAll('records[]');
        return json({ records: ids.map((id) => ({ id, deleted: true })) });
      }
      return json({
        records: (body?.records ?? []).map((r, i) => record(r.id ?? `new${i}`, r.fields)),
      });
    });
    const tasks = openrows.table(BASE, 'Tasks');
    const input = Array.from({ length: 23 }, (_, i) => ({ fields: { Name: `#${i}` } }));
    const created = await tasks.create(input, { typecast: true });
    expect(created.map((r) => r.fields['Name'])).toEqual(input.map((r) => r.fields.Name));
    expect(sent.map((s) => (s.body as { records: unknown[] }).records.length)).toEqual([10, 10, 3]);
    expect(sent[0]?.body).toMatchObject({ typecast: true });

    sent.length = 0;
    const updates = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, fields: { N: i } }));
    await tasks.update(updates);
    await tasks.replace(updates.slice(0, 2));
    expect(sent.map((s) => [s.method, (s.body as { records: unknown[] }).records.length])).toEqual([
      ['PATCH', 10],
      ['PATCH', 1],
      ['PUT', 2],
    ]);

    sent.length = 0;
    const ids = Array.from({ length: 12 }, (_, i) => `d${i}`);
    expect((await tasks.destroy(ids)).map((d) => d.id)).toEqual(ids);
    expect(sent.map((s) => new URL(s.url).searchParams.getAll('records[]').length)).toEqual([
      10, 2,
    ]);
  });

  it('merges upsert batches', async () => {
    let n = 0;
    const { openrows, sent } = client(() => {
      n++;
      return json({
        records: [record(`r${n}`)],
        createdRecords: n === 1 ? ['r1'] : [],
        updatedRecords: n === 1 ? [] : [`r${n}`],
      });
    });
    const records = Array.from({ length: 15 }, (_, i) => ({ fields: { Key: i } }));
    const res = await openrows.table(BASE, 'T').upsert(records, { fieldsToMergeOn: ['Key'] });
    expect(res).toMatchObject({ createdRecords: ['r1'], updatedRecords: ['r2'] });
    expect(sent[0]).toMatchObject({
      method: 'PATCH',
      body: { performUpsert: { fieldsToMergeOn: ['Key'] } },
    });
  });

  it('retries a 429 after Retry-After, then gives up after maxRetries', async () => {
    const limited = () =>
      json(
        {
          error: {
            type: 'TOO_MANY_REQUESTS',
            code: 'RATE_LIMITED',
            message: 'Slow down',
            requestId: 'req-1',
            limit: 'base',
          },
        },
        429,
        { 'retry-after': '2' }
      );
    const ok = client((_req, n) => (n < 3 ? limited() : json({ bases: [] })));
    expect(await ok.openrows.bases.list()).toEqual([]);
    expect(ok.waits).toEqual([2000, 2000]);

    const failing = client(limited, { maxRetries: 1 });
    const error = await failing.openrows.bases.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenRowsError);
    expect(error).toMatchObject({
      status: 429,
      type: 'TOO_MANY_REQUESTS',
      code: 'RATE_LIMITED',
      requestId: 'req-1',
      limit: 'base',
      retryAfter: 2,
      request: 'GET /api/v1/meta/bases',
    });
    expect(failing.sent).toHaveLength(2);

    // A wait longer than maxRetryDelay fails at once.
    const long = client(() => json({ error: {} }, 429, { 'retry-after': '120' }));
    await expect(long.openrows.bases.list()).rejects.toMatchObject({ status: 429 });
    expect(long.sent).toHaveLength(1);
  });

  it('turns error answers into OpenRowsError with the request id', async () => {
    const { openrows } = client(() =>
      json(
        {
          error: {
            type: 'INVALID_FILTER_BY_FORMULA',
            code: 'INVALID_FILTER_BY_FORMULA',
            message: 'LOWER is not supported',
            requestId: 'abc',
          },
        },
        422
      )
    );
    const error = await openrows
      .table(BASE, 'Tasks')
      .select({ filterByFormula: 'LOWER({Name})' })
      .firstPage()
      .catch((e: unknown) => e);
    expect(isOpenRowsError(error)).toBe(true);
    expect(error).toMatchObject({
      status: 422,
      type: 'INVALID_FILTER_BY_FORMULA',
      message: 'LOWER is not supported',
      requestId: 'abc',
    });

    const proxy = client(
      () =>
        new Response('<html>Bad gateway</html>', { status: 502, headers: { 'x-request-id': 'p1' } })
    );
    await expect(proxy.openrows.bases.list()).rejects.toMatchObject({
      status: 502,
      type: 'HTTP_502',
      requestId: 'p1',
    });
  });

  it('answers nothing for a 204 and encodes path parameters', async () => {
    const { openrows, sent } = client(() => new Response(null, { status: 204 }));
    await expect(openrows.webhooks(BASE).delete('w/1')).resolves.toBeUndefined();
    expect(sent[0]?.url).toBe(`https://rows.example.com/api/v1/bases/${BASE}/webhooks/w%2F1`);
  });
});

describe('helpers', () => {
  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
    const now = Date.parse('2026-10-27T10:00:00Z');
    expect(retryAfterMs('Tue, 27 Oct 2026 10:00:05 GMT', now)).toBe(5000);
  });

  it('normalizes the base URL', () => {
    expect(normalizeBaseUrl('https://a.example/')).toBe('https://a.example');
    expect(normalizeBaseUrl('https://a.example/api')).toBe('https://a.example');
    expect(normalizeBaseUrl('https://a.example/api/v1/')).toBe('https://a.example');
  });

  it('chunks by 10', () => {
    expect(chunks([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunks([])).toEqual([]);
  });
});
