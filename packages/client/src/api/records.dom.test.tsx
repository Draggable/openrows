import type { RecordData } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from './keys';
import { useDeleteRecords, useUpdateRecord } from './records';

const TABLE = '0190a000-0000-7000-8000-000000000001';
const R1 = '0190a000-0000-7000-8000-000000000002';
const R2 = '0190a000-0000-7000-8000-000000000003';
const NAME = '0190a000-0000-7000-8000-00000000000a';
const NOW = '2026-10-25T10:00:00.000Z';

const rec = (id: string, name: string, version = 1): RecordData => ({
  id,
  tableId: TABLE,
  version,
  fields: { [NAME]: name },
  createdAt: NOW,
  createdBy: null,
  updatedAt: NOW,
  updatedBy: null,
});

/** A fetch whose answer is released by hand, so the optimistic state can be observed. */
function deferredFetch() {
  let release: (res: Response) => void = () => {};
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, respond: (res: Response) => release(res) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const listKey = queryKeys.records.list(TABLE);
  const queryKey = queryKeys.records.query(TABLE, { offset: 0 });
  const detailKey = queryKeys.records.detail(TABLE, R1);
  qc.setQueryData(listKey, { records: [rec(R1, 'Ada'), rec(R2, 'Grace')], nextCursor: null });
  qc.setQueryData(queryKey, {
    records: [rec(R1, 'Ada')],
    offset: 0,
    total: 1,
    nextCursor: null,
  });
  qc.setQueryData(detailKey, rec(R1, 'Ada'));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const names = () => ({
    list: (qc.getQueryData(listKey) as { records: RecordData[] }).records.map(
      (r) => r.fields[NAME]
    ),
    query: (qc.getQueryData(queryKey) as { records: RecordData[] }).records.map(
      (r) => r.fields[NAME]
    ),
    detail: (qc.getQueryData(detailKey) as RecordData).fields[NAME],
  });
  return { qc, wrapper, names, detailKey };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useUpdateRecord', () => {
  it('shows the edit in every cache at once, then keeps the server version', async () => {
    const { fetchMock, respond } = deferredFetch();
    const { qc, wrapper, names, detailKey } = setup();
    const { result } = renderHook(() => useUpdateRecord(TABLE), { wrapper });

    act(() => result.current.mutate({ recordId: R1, fields: { [NAME]: 'Ada L.' } }));
    await waitFor(() => expect(names().detail).toBe('Ada L.'));
    expect(names()).toEqual({ list: ['Ada L.', 'Grace'], query: ['Ada L.'], detail: 'Ada L.' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/tables/${TABLE}/records/${R1}`);
    expect(JSON.parse(String(init.body))).toMatchObject({
      fields: { [NAME]: 'Ada L.' },
      clientOpId: expect.any(String),
    });

    respond(json(rec(R1, 'Ada L.', 2)));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect((qc.getQueryData(detailKey) as RecordData).version).toBe(2);
  });

  it('rolls every cache back when the server refuses the edit', async () => {
    const { respond } = deferredFetch();
    const { wrapper, names } = setup();
    const { result } = renderHook(() => useUpdateRecord(TABLE), { wrapper });

    act(() => result.current.mutate({ recordId: R1, fields: { [NAME]: 'Nope' }, ifVersion: 1 }));
    await waitFor(() => expect(names().detail).toBe('Nope'));

    respond(
      json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          code: 'CONFLICT',
          requestId: 'r1',
        },
        409
      )
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 409 });
    expect(names()).toEqual({ list: ['Ada', 'Grace'], query: ['Ada'], detail: 'Ada' });
  });
});

describe('useDeleteRecords', () => {
  it('removes records from lists at once and restores them on failure', async () => {
    const { respond } = deferredFetch();
    const { wrapper, names } = setup();
    const { result } = renderHook(() => useDeleteRecords(TABLE), { wrapper });

    act(() => result.current.mutate([R1]));
    await waitFor(() => expect(names().list).toEqual(['Grace']));
    expect(names().query).toEqual([]);

    respond(new Response('<html>502</html>', { status: 502 }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(names().list).toEqual(['Ada', 'Grace']);
  });
});
