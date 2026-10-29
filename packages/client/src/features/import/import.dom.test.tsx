import type { FieldMeta, TableMeta } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportDialog } from './ImportDialog';

const NOW = '2026-10-25T10:00:00.000Z';
const TABLE_ID = '0190a000-0000-7000-8000-000000000999';
const JOB_ID = '0190a000-0000-7000-8000-000000000777';
const nameField: FieldMeta = {
  id: '0190a000-0000-7000-8000-000000000001',
  tableId: TABLE_ID,
  name: 'Name',
  description: null,
  type: 'singleLineText',
  options: {},
  isPrimary: true,
  position: 1,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};
const table = {
  id: TABLE_ID,
  baseId: '0190a000-0000-7000-8000-000000000998',
  name: 'Tasks',
  fields: [nameField],
} as unknown as TableMeta;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const job = (status: 'running' | 'done', processedRows: number) => ({
  id: JOB_ID,
  tableId: TABLE_ID,
  status,
  totalRows: 2,
  processedRows,
  skippedCells: 0,
  createdFieldIds: [],
  error: null,
  createdAt: NOW,
  finishedAt: status === 'done' ? NOW : null,
});

afterEach(() => vi.unstubAllGlobals());

describe('ImportDialog', () => {
  it('previews the file, maps the columns, starts the import and follows it', async () => {
    const posted: Record<string, unknown>[] = [];
    let polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'http://localhost').pathname;
        if (init?.method === 'POST' && path.endsWith('/imports')) {
          posted.push(JSON.parse(String(init.body)));
          return json(job('running', 0), 201);
        }
        if (path.endsWith(`/imports/${JOB_ID}`)) {
          polls++;
          return json(job(polls > 1 ? 'done' : 'running', polls > 1 ? 2 : 1));
        }
        return json({});
      })
    );
    const onOpenChange = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ImportDialog table={table} open onOpenChange={onOpenChange} canCreateFields />
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    const file = new File(['name,Points\nA,1\nB,2.5\n'], 'tasks.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText('Choose a CSV file'), file);

    expect(await screen.findByText('tasks.csv')).toBeTruthy();
    expect(screen.getByLabelText('Import column name into')).toHaveProperty('value', nameField.id);
    expect(screen.getByLabelText('Import column Points into')).toHaveProperty('value', 'new');
    expect(screen.getByLabelText('Type of the new field for Points')).toHaveProperty(
      'value',
      'number'
    );
    // "Add missing options" is on by default for roles that may change fields.
    expect(screen.getByLabelText('Add missing options to select fields')).toHaveProperty(
      'checked',
      true
    );
    await user.click(screen.getByRole('button', { name: 'Import 2 records' }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      csv: 'name,Points\nA,1\nB,2.5\n',
      hasHeader: true,
      typecast: true,
      columns: [
        { index: 0, fieldId: nameField.id },
        { index: 1, newField: { name: 'Points', type: 'number', options: { precision: 1 } } },
      ],
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false), { timeout: 4000 });
  });

  it('says why a file is refused', async () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ImportDialog table={table} open onOpenChange={() => {}} canCreateFields={false} />
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText('Choose a CSV file'),
      new File(['a,"open\n'], 'bad.csv', { type: 'text/csv' })
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not a valid CSV/);
  });
});
