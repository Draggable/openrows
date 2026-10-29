import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './client';

const TABLE = '0190a000-0000-7000-8000-000000000001';
const RECORD = '0190a000-0000-7000-8000-000000000002';
const NOW = '2026-10-25T10:00:00.000Z';
const record = {
  id: RECORD,
  tableId: TABLE,
  version: 1,
  fields: {},
  createdAt: NOW,
  createdBy: null,
  updatedAt: NOW,
  updatedBy: null,
};

function mockFetch(body: string | null, init: ResponseInit = { status: 200 }) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(body, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('calls the contract URL once (no doubled /api prefix) and parses the response', async () => {
    const fetchMock = mockFetch(JSON.stringify({ records: [record], nextCursor: null, extra: 1 }));
    const page = await api.records.list({ params: { tableId: TABLE }, query: { limit: 10 } });
    expect(page).toEqual({ records: [record], nextCursor: null });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/tables/${TABLE}/records?limit=10`);
  });

  it('sends JSON bodies with credentials', async () => {
    const fetchMock = mockFetch(JSON.stringify(record), { status: 201 });
    await api.records.create({ params: { tableId: TABLE }, body: { fields: {} } });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"fields":{}}');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  });

  it('answers null for 204 endpoints', async () => {
    mockFetch(null, { status: 204 });
    await expect(
      api.records.delete({ params: { tableId: TABLE, recordId: RECORD } })
    ).resolves.toBeNull();
  });

  it('throws ApiError with the problem+json code, detail and request id', async () => {
    const problem = {
      type: 'https://openrows.io/problems/not-found',
      title: 'Not found',
      status: 404,
      detail: 'No such record in this table.',
      code: 'NOT_FOUND',
      requestId: 'req-1',
    };
    mockFetch(JSON.stringify(problem), { status: 404 });
    const error = await api.records
      .get({ params: { tableId: TABLE, recordId: RECORD } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      message: 'No such record in this table.',
      code: 'NOT_FOUND',
      requestId: 'req-1',
    });
  });

  it('uses the problem title when there is no detail', async () => {
    const problem = {
      type: 'x',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      requestId: 'r',
    };
    mockFetch(JSON.stringify(problem), { status: 404 });
    const error = await api.workspaces.list().catch((e: unknown) => e);
    expect(error).toMatchObject({ message: 'Not found', code: 'NOT_FOUND' });
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    mockFetch('<html>Bad Gateway</html>', { status: 502 });
    await expect(api.me.get()).rejects.toMatchObject({
      status: 502,
      message: 'Request failed with status 502',
    });
  });

  it('throws ApiError when the response does not match the contract', async () => {
    mockFetch(JSON.stringify({ id: 1 }));
    const error = await api.me.get().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 200,
      message: 'Unexpected response from GET /api/me (status 200)',
    });
  });
});
