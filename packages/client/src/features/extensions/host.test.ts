import type { ExtensionScope, FieldMeta, QueryRecordsResult } from '@openrows/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { HostTable, ScriptApi } from '../scripts/host';
import {
  callErrorMessage,
  createExtensionCallHandler,
  cursorOf,
  type ExtensionHostDeps,
  extensionBase,
} from './host';

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

function setUp(scopes: ExtensionScope[], canEditSettings = true) {
  const api: ScriptApi = {
    query: vi.fn(
      async () =>
        ({
          records: [row(R1, 'Pen', 3), row(R2, 'Ink', 1)],
          offset: null,
          total: null,
          nextCursor: null,
        }) as unknown as QueryRecordsResult
    ),
    get: vi.fn(async () => row(R1, 'Pen', 3)),
    create: vi.fn(async () => [row(R1, 'Pen', 3)]),
    update: vi.fn(async () => [row(R1, 'Pen', 3)]),
    delete: vi.fn(async () => {}),
  } as unknown as ScriptApi;
  const deps: ExtensionHostDeps = {
    api,
    saveSettings: vi.fn(async (s) => s),
    openUrl: vi.fn(),
    sleep: async () => {},
  };
  const host = createExtensionCallHandler({
    scopes,
    canEditSettings,
    getTables: () => TABLES,
    deps,
  });
  return { ...host, api, deps };
}

describe('the extension host', () => {
  it('refuses every call its manifest has no scope for', async () => {
    const { handle, api, deps } = setUp([]);
    await expect(handle('select', { tableId: T })).rejects.toThrow(/may not read records/);
    await expect(handle('get', { tableId: T, recordId: R1 })).rejects.toThrow(/records:read/);
    await expect(handle('watch', { tableId: T })).rejects.toThrow(/records:read/);
    await expect(
      handle('create', { tableId: T, records: [{ fields: { [NAME]: 'x' } }] })
    ).rejects.toThrow(/may not change records/);
    await expect(handle('delete', { tableId: T, recordIds: [R1] })).rejects.toThrow(
      /records:write/
    );
    await expect(handle('setSettings', { settings: { a: 1 } })).rejects.toThrow(/settings:write/);
    expect(api.query).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    expect(deps.saveSettings).not.toHaveBeenCalled();
  });

  it('reads with records:read but never writes without records:write', async () => {
    const { handle, api } = setUp(['records:read']);
    const res = (await handle('select', { tableId: T, fieldIds: [QTY] })) as {
      records: { id: string; name: string; strings: Record<string, string> }[];
    };
    expect(res.records.map((r) => r.name)).toEqual(['Pen', 'Ink']);
    expect(res.records[0]?.strings[QTY]).toBe('3');
    expect(api.query).toHaveBeenCalledWith(
      T,
      expect.objectContaining({ query: { fields: [NAME, QTY] } })
    );
    await expect(
      handle('update', { tableId: T, records: [{ id: R1, fields: { [QTY]: 2 } }] })
    ).rejects.toThrow(/records:write/);
    expect(api.update).not.toHaveBeenCalled();
  });

  it('writes with records:write, through the API, only to the base’s fields', async () => {
    const { handle, api } = setUp(['records:read', 'records:write']);
    await expect(
      handle('create', { tableId: T, records: [{ fields: { [NAME]: 'New' } }] })
    ).resolves.toEqual({ ids: [R1] });
    expect(api.create).toHaveBeenCalledWith(T, [{ fields: { [NAME]: 'New' } }]);
    await expect(
      handle('update', { tableId: T, records: [{ id: R1, fields: { [OTHER]: 1 } }] })
    ).rejects.toThrow('No such field in Items.');
    await expect(handle('select', { tableId: OTHER })).rejects.toThrow('No such table');
    await expect(handle('select', { tableId: T, viewId: OTHER })).rejects.toThrow('No such view');
  });

  it('caps selects at their limit and answers null for a missing record', async () => {
    const { handle } = setUp(['records:read'], true);
    const res = (await handle('select', { tableId: T, limit: 1 })) as { records: unknown[] };
    expect(res.records).toHaveLength(1);
    const gone = setUp(['records:read']);
    (gone.api.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(404, 'Not found')
    );
    await expect(gone.handle('get', { tableId: T, recordId: R2 })).resolves.toBeNull();
  });

  it('keeps settings to editors with settings:write', async () => {
    const editor = setUp(['settings:write']);
    await editor.handle('setSettings', { settings: { tableId: T } });
    expect(editor.deps.saveSettings).toHaveBeenCalledWith({ tableId: T });
    const viewer = setUp(['settings:write'], false);
    await expect(viewer.handle('setSettings', { settings: {} })).rejects.toThrow(/editors/);
    await expect(
      editor.handle('setSettings', { settings: { big: 'x'.repeat(70_000) } })
    ).rejects.toThrow('Invalid setSettings call.');
  });

  it('opens only http(s) links and refuses malformed calls', async () => {
    const { handle, deps } = setUp([]);
    await handle('openUrl', { url: 'https://example.com/a' });
    expect(deps.openUrl).toHaveBeenCalledWith('https://example.com/a');
    await expect(handle('openUrl', { url: 'javascript:alert(1)' })).rejects.toThrow('Invalid');
    const reader = setUp(['records:read']);
    await expect(reader.handle('select', { tableId: 'not-an-id' })).rejects.toThrow('Invalid');
  });

  it('tracks watched tables', async () => {
    const { handle, watched } = setUp(['records:read']);
    await handle('watch', { tableId: T });
    expect([...watched]).toEqual([T]);
    await handle('unwatch', { tableId: T });
    expect(watched.size).toBe(0);
  });

  it('gives no tables without records:read, and the expanded record as the cursor', () => {
    const base = { id: R1, name: 'Base' };
    expect(extensionBase(base, TABLES, []).tables).toEqual([]);
    expect(extensionBase(base, TABLES, ['records:read']).tables[0]?.fields).toHaveLength(2);
    expect(
      cursorOf({
        tableId: T,
        viewId: VIEW,
        selectedRecordId: R1,
        selectedFieldId: QTY,
        expandedRecordId: R2,
      })
    ).toEqual({ tableId: T, viewId: VIEW, recordId: R2, fieldId: null });
    expect(callErrorMessage(new Error('secret'))).toBe('The request failed.');
  });
});
