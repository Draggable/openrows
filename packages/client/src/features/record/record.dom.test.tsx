import type { FieldMeta, FieldTypeName, RecordData, TableMeta } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui';
import { RecordExpand, type RecordExpandProps } from './RecordExpand';

const NOW = '2026-10-25T10:00:00.000Z';
const TABLE = '0190a000-0000-7000-8000-000000000001';
const REC = '0190a000-0000-7000-8000-000000000002';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const field = (n: number, name: string, type: FieldTypeName, options: unknown = {}): FieldMeta => ({
  id: id(100 + n),
  tableId: TABLE,
  name,
  description: null,
  type,
  options,
  isPrimary: n === 1,
  position: n,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

const NAME = field(1, 'Name', 'singleLineText');
const NOTES = field(2, 'Notes', 'longText');
const DONE = field(3, 'Done', 'checkbox');
const CREATED = field(4, 'Created', 'createdTime');
const SECRET = field(5, 'Secret', 'singleLineText');
const FIELDS = [NAME, NOTES, DONE, CREATED, SECRET];

const table: TableMeta = {
  id: TABLE,
  baseId: id(9),
  name: 'Features',
  description: null,
  icon: null,
  position: 1,
  schemaVersion: 1,
  createdAt: NOW,
  updatedAt: NOW,
  fields: FIELDS,
} as TableMeta;

const record: RecordData = {
  id: REC,
  tableId: TABLE,
  version: 1,
  fields: {
    [NAME.id]: 'Linked records',
    [NOTES.id]: 'Line one\nLine two',
    [DONE.id]: false,
    [CREATED.id]: NOW,
    [SECRET.id]: 'hidden value',
  },
  createdAt: NOW,
  createdBy: null,
  updatedAt: NOW,
  updatedBy: null,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

function show(props: Partial<RecordExpandProps> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    // The comments panel loads beside the fields.
    if (url.endsWith('/comments')) return json({ comments: [], previousCursor: null });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return json({ ...record, version: 2, fields: { ...record.fields, ...body.fields } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  const onLayoutChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RecordExpand
          userRole="owner"
          table={table}
          fields={FIELDS}
          hidden={[SECRET.id]}
          recordId={REC}
          cached={record}
          index={0}
          total={3}
          canEdit
          layout="modal"
          onLayoutChange={onLayoutChange}
          onNavigate={onNavigate}
          onClose={onClose}
          onDelete={() => {}}
          {...props}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
  return { fetchMock, onNavigate, onClose, onLayoutChange };
}

describe('RecordExpand', () => {
  it('shows every field, the title and the position, hidden fields last', () => {
    show();
    const dialog = screen.getByRole('dialog', { name: 'Linked records' });
    expect(within(dialog).getByTestId('record-position').textContent).toBe('Record 1 of 3');
    expect(within(dialog).getByText(/Line one\s+Line two/)).toBeTruthy();
    expect(within(dialog).getByText('Hidden in this view')).toBeTruthy();
    expect(within(dialog).getByText('hidden value')).toBeTruthy();
    // The created time is computed: shown, never editable.
    expect(within(dialog).queryByRole('button', { name: 'Created' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Name' })).toBeTruthy();
  });

  it('steps with the arrows and the buttons, stops at the first record, closes on Esc', async () => {
    const user = userEvent.setup();
    const { onNavigate, onClose } = show();
    expect(
      (screen.getByRole('button', { name: 'Previous record' }) as HTMLButtonElement).disabled
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Next record' }));
    expect(onNavigate).toHaveBeenLastCalledWith(1);
    await user.keyboard('{ArrowUp}');
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await user.keyboard('{ArrowDown}');
    await user.keyboard('j');
    expect(onNavigate).toHaveBeenCalledTimes(3);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('edits a field with its editor and saves it; Esc in an editor only closes the editor', async () => {
    const user = userEvent.setup();
    const { fetchMock, onClose, onNavigate } = show();
    await user.click(screen.getByRole('button', { name: 'Name' }));
    const input = screen.getByRole('textbox', { name: 'Name' });
    await user.keyboard('{ArrowDown}');
    expect(onNavigate).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, 'Renamed{Enter}');
    const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    await waitFor(() => expect(patches()).toHaveLength(1));
    const [url, init] = patches()[0] ?? [];
    expect(url).toBe(`/api/tables/${TABLE}/records/${REC}`);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body)).fields).toEqual({ [NAME.id]: 'Renamed' });

    await user.click(screen.getByRole('button', { name: 'Name' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('toggles a checkbox in place', async () => {
    const user = userEvent.setup();
    const { fetchMock } = show();
    await user.click(screen.getByRole('checkbox', { name: 'Done' }));
    const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0]?.[1]?.body)).fields).toEqual({
      [DONE.id]: true,
    });
  });

  it('is read-only below editor', () => {
    show({ canEdit: false });
    expect(screen.queryByRole('button', { name: 'Name' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More record actions' })).toBeNull();
    expect(screen.getByText('Linked records', { selector: 'h2' })).toBeTruthy();
  });

  it('switches to the side panel', async () => {
    const user = userEvent.setup();
    const { onLayoutChange } = show();
    await user.click(screen.getByRole('button', { name: 'Show as a side panel' }));
    expect(onLayoutChange).toHaveBeenCalledWith('panel');
  });

  it('loads a deep-linked record the grid has not loaded, or says it is gone', async () => {
    const fetchMock = vi.fn(async (_url: string) => json({ status: 404, title: 'Not found' }, 404));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <RecordExpand
            userRole="owner"
            table={table}
            fields={FIELDS}
            hidden={[]}
            recordId={REC}
            cached={undefined}
            index={null}
            total={3}
            canEdit
            layout="panel"
            onLayoutChange={() => {}}
            onNavigate={() => {}}
            onClose={() => {}}
            onDelete={() => {}}
          />
        </TooltipProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByText('Record not found')).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/tables/${TABLE}/records/${REC}`);
    expect(screen.getByTestId('record-position').textContent).toBe('Record');
    expect(
      (screen.getByRole('button', { name: 'Next record' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
