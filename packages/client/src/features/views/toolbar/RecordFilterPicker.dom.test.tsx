import type { FieldMeta, FilterCondition } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConditionRow } from './FilterMenu';

// A link filter by specific records: `has any of` / `has none of` with a record picker.

const NOW = '2026-10-25T10:00:00.000Z';
const LINKED = '0190a000-0000-7000-8000-000000000902';
const link: FieldMeta = {
  id: '0190a000-0000-7000-8000-000000000001',
  tableId: '0190a000-0000-7000-8000-000000000901',
  name: 'Project',
  description: null,
  type: 'link',
  options: { linkedTableId: LINKED },
  isPrimary: false,
  position: 1,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};
const id = (i: number) => `0190a000-0000-7000-8000-${String(100 + i).padStart(12, '0')}`;
// 60 records: two pages of 50.
const RECORDS = Array.from({ length: 60 }, (_, i) => ({
  id: id(i),
  name: i === 0 ? 'Alpha' : i === 1 ? 'Beta' : `Project ${i}`,
}));
const GONE = '0190a000-0000-7000-8000-000000000999';

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

function Harness({
  initial,
  changes,
}: {
  initial: FilterCondition;
  changes: (FilterCondition | null)[];
}) {
  const [cond, setCond] = useState<FilterCondition>(initial);
  return (
    <ConditionRow
      fields={[link]}
      cond={cond}
      onChange={(next) => {
        changes.push(next);
        if (next) setCond(next);
      }}
    />
  );
}

function setup(initial: FilterCondition) {
  const urls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      urls.push(url);
      const q = url.searchParams;
      let records = RECORDS;
      let nextOffset: number | null = null;
      const ids = q.get('ids');
      if (ids) {
        records = ids.split(',').flatMap((x) => RECORDS.filter((r) => r.id === x));
      } else {
        const search = q.get('search')?.toLowerCase() ?? '';
        const matches = RECORDS.filter((r) => r.name.toLowerCase().includes(search));
        const offset = Number(q.get('offset') ?? 0);
        const limit = Number(q.get('limit') ?? 50);
        records = matches.slice(offset, offset + limit);
        nextOffset = offset + limit < matches.length ? offset + limit : null;
      }
      return new Response(JSON.stringify({ tableId: LINKED, records, nextOffset }), {
        headers: { 'content-type': 'application/json' },
      });
    })
  );
  const changes: (FilterCondition | null)[] = [];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Harness initial={initial} changes={changes} />
    </QueryClientProvider>
  );
  return { urls, changes, user: userEvent.setup() };
}

describe('link filter by record (#82)', () => {
  it('offers has any of / has none of on links, with a record picker', async () => {
    const { urls, changes, user } = setup({ fieldId: link.id, operator: 'contains' });
    const operators = [...screen.getByLabelText('Operator').querySelectorAll('option')].map(
      (o) => o.textContent
    );
    expect(operators).toEqual(expect.arrayContaining(['has any of', 'has none of']));
    await user.selectOptions(screen.getByLabelText('Operator'), 'has any of');
    await user.click(screen.getByRole('button', { name: 'Pick records' }));
    const list = await screen.findByRole('listbox', { name: 'Records for Project' });
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(50));
    // Every record of the linked table, not only a "limit to a view" one.
    expect(urls.some((u) => u.searchParams.get('purpose') === 'filter')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(60));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    await user.type(screen.getByRole('combobox', { name: 'Find a record for Project' }), 'bet');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
    await user.keyboard('{Enter}');
    expect(changes.at(-1)).toEqual({ fieldId: link.id, operator: 'hasAnyOf', value: [id(1)] });
    expect(within(list).getByRole('option', { name: 'Beta' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: 'Remove Beta' })).toBeTruthy();
  });

  it('names saved records by id, marks deleted ones, and removes chips', async () => {
    const { urls, changes, user } = setup({
      fieldId: link.id,
      operator: 'hasNoneOf',
      value: [id(0), GONE],
    });
    expect(await screen.findByRole('button', { name: 'Remove Alpha' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Remove Deleted record' })).toBeTruthy();
    expect(urls.find((u) => u.searchParams.has('ids'))?.searchParams.get('ids')).toBe(
      `${id(0)},${GONE}`
    );
    await user.click(screen.getByRole('button', { name: 'Remove Deleted record' }));
    expect(changes.at(-1)).toEqual({ fieldId: link.id, operator: 'hasNoneOf', value: [id(0)] });
    await user.click(screen.getByRole('button', { name: 'Remove Alpha' }));
    expect(changes.at(-1)).toEqual({ fieldId: link.id, operator: 'hasNoneOf' });
    expect(screen.getByRole('button', { name: 'Pick records' })).toBeTruthy();
  });

  it('switching back to contains drops the ids', async () => {
    const { changes, user } = setup({ fieldId: link.id, operator: 'hasAnyOf', value: [id(0)] });
    await user.selectOptions(screen.getByLabelText('Operator'), 'contains');
    expect(changes.at(-1)).toEqual({ fieldId: link.id, operator: 'contains' });
    expect(screen.getByLabelText('Value of Project').tagName).toBe('INPUT');
  });
});
