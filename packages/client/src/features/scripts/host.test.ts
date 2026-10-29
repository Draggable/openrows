import { type FieldMeta, SCRIPT_RUN_LIMITS } from '@openrows/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { callErrorMessage, createCallHandler, type HostTable, type ScriptApi } from './host';

const T = '01900000-0000-7000-8000-000000000001';
const NAME = '01900000-0000-7000-8000-000000000002';
const QTY = '01900000-0000-7000-8000-000000000003';
const VIEW = '01900000-0000-7000-8000-000000000004';
const OTHER = '01900000-0000-7000-8000-000000000009';
const R1 = '01900000-0000-7000-8000-0000000000a1';
const R2 = '01900000-0000-7000-8000-0000000000a2';

const field = (id: string, name: string, type: string, isPrimary = false) =>
  ({
    id,
    tableId: T,
    name,
    type,
    options: {},
    isPrimary,
    description: null,
  }) as unknown as FieldMeta;

const TABLES: HostTable[] = [
  {
    id: T,
    name: 'Items',
    description: null,
    fields: [field(NAME, 'Name', 'singleLineText', true), field(QTY, 'Qty', 'number')],
    views: [{ id: VIEW, name: 'Grid', type: 'grid' }],
  },
];

const row = (id: string, name: string, qty: number) => ({
  id,
  tableId: T,
  version: 1,
  fields: { [NAME]: name, [QTY]: qty },
  createdAt: '2026-10-28T10:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-10-28T10:00:00.000Z',
  updatedBy: null,
});

function setUp(api: Partial<ScriptApi> = {}) {
  const calls: string[] = [];
  const full: ScriptApi = {
    query: vi.fn(async () => ({
      records: [row(R1, 'Pen', 3), row(R2, 'Ink', 1)],
      offset: null,
      total: null,
      nextCursor: null,
    })),
    get: vi.fn(async () => row(R1, 'Pen', 3)),
    create: vi.fn(async () => [row(R1, 'Pen', 3)]),
    update: vi.fn(async () => [row(R1, 'Pen', 3)]),
    delete: vi.fn(async () => {}),
    ...api,
  };
  let clock = 0;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const handle = createCallHandler(TABLES, {
    api: full,
    prompt: async (p) => {
      calls.push(p.kind);
      if (p.kind === 'record') return p.records[1]?.id ?? null;
      if (p.kind === 'table') return T;
      return 'x';
    },
    output: () => {},
    sleep,
    now: () => clock,
  });
  return { handle, api: full, sleep, calls };
}

describe('the script host (#152)', () => {
  it('selects through the records query, with the primary field and display text', async () => {
    const { handle, api } = setUp();
    const res = (await handle('select', { tableId: T, viewId: VIEW, fieldIds: [QTY] })) as {
      records: { id: string; name: string; strings: Record<string, string> }[];
    };
    expect(api.query).toHaveBeenCalledWith(T, {
      viewId: VIEW,
      query: { fields: [NAME, QTY] },
      limit: 1000,
      count: false,
      groups: false,
    });
    expect(res.records.map((r) => [r.id, r.name, r.strings[QTY]])).toEqual([
      [R1, 'Pen', '3'],
      [R2, 'Ink', '1'],
    ]);
  });

  it('pages by cursor and keeps the asked-for records only', async () => {
    const pages = [
      { records: [row(R1, 'Pen', 3)], offset: null, total: null, nextCursor: 'c1' },
      { records: [row(R2, 'Ink', 1)], offset: null, total: null, nextCursor: null },
    ];
    const query = vi.fn(async () => pages.shift() ?? pages[0]);
    const { handle } = setUp({ query: query as unknown as ScriptApi['query'] });
    const res = (await handle('select', { tableId: T, recordIds: [R2] })) as {
      records: { id: string }[];
    };
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]).toMatchObject([T, { cursor: 'c1' }]);
    expect(res.records.map((r) => r.id)).toEqual([R2]);
  });

  it("refuses other bases' tables, unknown fields and views, and malformed calls", async () => {
    const { handle, api } = setUp();
    await expect(handle('select', { tableId: OTHER })).rejects.toThrow(
      'No such table in this base.'
    );
    await expect(
      handle('create', { tableId: T, records: [{ fields: { [OTHER]: 1 } }] })
    ).rejects.toThrow('No such field in Items.');
    await expect(handle('select', { tableId: T, viewId: OTHER })).rejects.toThrow(
      'No such view in Items.'
    );
    await expect(handle('delete', { tableId: T, recordIds: ['nope'] })).rejects.toThrow(
      'Invalid delete call.'
    );
    const tooMany = Array.from({ length: SCRIPT_RUN_LIMITS.maxWriteBatch + 1 }, () => ({
      fields: {},
    }));
    await expect(handle('create', { tableId: T, records: tooMany })).rejects.toThrow(
      'Invalid create call.'
    );
    expect(api.create).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('writes through the API and passes its refusals on', async () => {
    const { handle, api } = setUp({
      update: vi.fn(async () => {
        throw new ApiError(
          403,
          "You can't edit records in this table.",
          undefined,
          'EDIT_RESTRICTED'
        );
      }),
    });
    expect(await handle('create', { tableId: T, records: [{ fields: { [NAME]: 'A' } }] })).toEqual({
      ids: [R1],
    });
    expect(api.create).toHaveBeenCalledWith(T, [{ fields: { [NAME]: 'A' } }]);
    const refused = await handle('update', { tableId: T, records: [{ id: R1, fields: {} }] }).catch(
      (err: unknown) => err
    );
    expect(callErrorMessage(refused)).toBe("You can't edit records in this table.");
    expect(await handle('delete', { tableId: T, recordIds: [R1, R1] })).toEqual({ ids: [R1] });
    expect(api.delete).toHaveBeenCalledWith(T, [R1]);
  });

  it('answers a missing record with null', async () => {
    const { handle } = setUp({
      get: vi.fn(async () => {
        throw new ApiError(404, 'Not found');
      }),
    });
    expect(await handle('get', { tableId: T, recordId: R1 })).toBeNull();
  });

  it('caps the records a run changes', async () => {
    const { handle } = setUp();
    const records = Array.from({ length: 50 }, () => ({ fields: {} }));
    for (let i = 0; i < SCRIPT_RUN_LIMITS.maxRecordsWritten / 50; i += 1) {
      await handle('create', { tableId: T, records });
    }
    await expect(handle('create', { tableId: T, records: [{ fields: {} }] })).rejects.toThrow(
      /at most 10,000 records/
    );
  });

  it('throttles to the calls per second', async () => {
    const { handle, sleep } = setUp();
    for (let i = 0; i < SCRIPT_RUN_LIMITS.callsPerSecond; i += 1) {
      await handle('get', { tableId: T, recordId: R1 });
    }
    expect(sleep).not.toHaveBeenCalled();
    await handle('get', { tableId: T, recordId: R1 });
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it('asks for input and checks the answers against the base', async () => {
    const { handle, calls } = setUp();
    expect(await handle('input', { kind: 'table', label: 'Table' })).toBe(T);
    const record = (await handle('input', { kind: 'record', label: 'Pick', tableId: T })) as {
      id: string;
    };
    expect(record.id).toBe(R2);
    await expect(handle('input', { kind: 'field', label: 'F', tableId: T })).rejects.toThrow(
      'No such field in Items.'
    );
    expect(calls).toEqual(['table', 'record', 'field']);
  });
});
