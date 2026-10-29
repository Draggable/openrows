import type { FieldMeta } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pastedValue, planPaste } from '../clipboard/clipboard';
import { CellContent } from './CellContent';
import { CellEditor } from './editors';
import { linkItems } from './model';

const NOW = '2026-10-25T10:00:00.000Z';
const TABLE = '0190a000-0000-7000-8000-000000000999';
const LINKED = '0190a000-0000-7000-8000-000000000888';
const ALPHA = '0190a000-0000-7000-8000-00000000000a';
const BETA = '0190a000-0000-7000-8000-00000000000b';

const linkField = (options: Record<string, unknown> = {}): FieldMeta => ({
  id: '0190a000-0000-7000-8000-000000000001',
  tableId: TABLE,
  name: 'Projects',
  description: null,
  type: 'link',
  options: { linkedTableId: LINKED, ...options },
  isPrimary: false,
  position: 1,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const RECORDS = [
  { id: ALPHA, name: 'Alpha' },
  { id: BETA, name: 'Beta' },
];

/** The picker against a stubbed candidates endpoint (search on the names). */
function edit(field: FieldMeta, value: unknown) {
  const fetchMock = vi.fn(async (url: string) => {
    const search = new URL(url, 'http://x').searchParams.get('search')?.toLowerCase() ?? '';
    const records = RECORDS.filter((r) => r.name.toLowerCase().includes(search));
    return new Response(JSON.stringify({ tableId: LINKED, records, nextOffset: null }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <div style={{ position: 'relative', width: 200, height: 34 }}>
        <CellEditor
          field={field}
          value={value}
          align="left"
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </div>
    </QueryClientProvider>
  );
  return { fetchMock, onCommit, onCancel };
}

describe('link cells (#34)', () => {
  it('shows one chip per linked record, "Unnamed record" for an empty name', () => {
    render(
      <CellContent
        field={linkField()}
        value={[
          { id: ALPHA, name: 'Alpha' },
          { id: BETA, name: '' },
        ]}
      />
    );
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Unnamed record')).toBeTruthy();
  });

  it('reads pending names and server values alike', () => {
    expect(linkItems(null)).toEqual([]);
    expect(linkItems('Alpha')).toEqual([{ id: 'pending-0', name: 'Alpha' }]);
    expect(linkItems([{ id: ALPHA, name: 'Alpha' }, { id: BETA }, 3])).toEqual([
      { id: ALPHA, name: 'Alpha' },
      { id: BETA, name: '' },
    ]);
  });

  it('the picker searches the linked table and toggles records, saving on Escape', async () => {
    const user = userEvent.setup();
    const { fetchMock, onCommit } = edit(linkField(), [{ id: ALPHA, name: 'Alpha' }]);
    const list = await screen.findByRole('listbox', { name: 'Records for Projects' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2));
    expect(within(list).getByRole('option', { name: 'Alpha' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    await user.click(within(list).getByRole('option', { name: 'Beta' }));
    await user.click(screen.getByRole('button', { name: 'Unlink Alpha' }));
    await user.type(screen.getByRole('combobox'), 'bet');
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/api/fields/${linkField().id}/link-candidates?search=bet`),
        expect.anything()
      )
    );
    await user.keyboard('{Escape}');
    expect(onCommit).toHaveBeenCalledWith({ value: [{ id: BETA, name: 'Beta' }] }, 'stay');
  });

  it('with one record allowed, a pick saves; a new name saves with typecast', async () => {
    const user = userEvent.setup();
    const single = linkField({ prefersSingleRecordLink: true });
    const first = edit(single, null);
    const list = await screen.findByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2));
    await user.click(within(list).getByRole('option', { name: 'Beta' }));
    expect(first.onCommit).toHaveBeenCalledWith({ value: [{ id: BETA, name: 'Beta' }] }, 'stay');
    cleanup();

    const second = edit(single, null);
    await user.type(screen.getByRole('combobox'), 'Gamma');
    const add = await screen.findByRole('option', { name: 'Add "Gamma"' });
    await user.click(add);
    expect(second.onCommit).toHaveBeenCalledWith({ value: ['Gamma'], typecast: true }, 'stay');
  });

  it('pastes names for the server to match, with typecast', () => {
    const field = linkField();
    expect(pastedValue(field, { text: ' Alpha, Beta ' })).toBe('Alpha, Beta');
    expect(pastedValue(field, { text: '' })).toBeNull();
    expect(pastedValue(field, { text: 'Alpha', value: ['Alpha'] })).toEqual(['Alpha']);
    const plan = planPaste(
      [[{ text: 'Alpha' }]],
      { top: 0, left: 0, bottom: 0, right: 0 },
      [field],
      1,
      () => ({ [field.id]: null })
    );
    expect(plan.updates).toEqual([{ row: 0, fields: { [field.id]: 'Alpha' } }]);
    expect(plan.typecast).toBe(true);
  });
});
