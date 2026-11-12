/// <reference types="node" />
import { readFileSync } from 'node:fs';
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

/** Answers the import's POST with a running job and its polls with progress, then done. */
function stubImportApi(posted: Record<string, unknown>[]) {
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
}

describe('ImportDialog', () => {
  it('previews the file, maps the columns, starts the import and follows it', async () => {
    const posted: Record<string, unknown>[] = [];
    stubImportApi(posted);
    const onOpenChange = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ImportDialog table={table} open onOpenChange={onOpenChange} canCreateFields />
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    const file = new File(['name,Points\nA,1\nB,2.5\n'], 'tasks.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText('Choose a CSV or Excel file'), file);

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

  it('imports the sheet chosen from a workbook', async () => {
    const bytes = readFileSync(`${import.meta.dirname}/__fixtures__/tasks.xlsx`);
    const posted: Record<string, unknown>[] = [];
    stubImportApi(posted);
    const onOpenChange = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ImportDialog table={table} open onOpenChange={onOpenChange} canCreateFields />
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText('Choose a CSV or Excel file'),
      new File([new Uint8Array(bytes)], 'tasks.xlsx')
    );

    // The first sheet, with the types inferred from its values.
    expect(await screen.findByText('tasks.xlsx')).toBeTruthy();
    const sheet = screen.getByLabelText('Sheet');
    expect(sheet).toHaveProperty('value', 'Tasks');
    expect(Array.from((sheet as HTMLSelectElement).options, (o) => o.value)).toEqual([
      'Tasks',
      'Notes',
      'Empty',
    ]);
    expect(screen.getByLabelText('Type of the new field for Points')).toHaveProperty(
      'value',
      'number'
    );
    expect(screen.getByLabelText('Type of the new field for Due')).toHaveProperty('value', 'date');
    expect(screen.getByLabelText('Type of the new field for Done')).toHaveProperty(
      'value',
      'checkbox'
    );

    // An empty sheet says so; another sheet brings its own columns.
    await user.selectOptions(sheet, 'Empty');
    expect(screen.getByText('This sheet is empty. Choose another one.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.selectOptions(sheet, 'Notes');
    expect(screen.queryByLabelText('Import column Points into')).toBeNull();
    expect(screen.getByLabelText('Import column Note into')).toHaveProperty('value', 'new');

    await user.click(screen.getByRole('button', { name: 'Import 1 record' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      xlsx: bytes.toString('base64'),
      sheet: 'Notes',
      hasHeader: true,
      typecast: true,
      columns: [{ index: 0, newField: { name: 'Note', type: 'singleLineText', options: {} } }],
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
      screen.getByLabelText('Choose a CSV or Excel file'),
      new File(['a,"open\n'], 'bad.csv', { type: 'text/csv' })
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not a valid CSV/);
  });

  it('says why a workbook is refused', async () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <ImportDialog table={table} open onOpenChange={() => {}} canCreateFields={false} />
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText('Choose a CSV or Excel file'),
      new File(['not a zip'], 'report.xlsx')
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The file is not a valid Excel workbook (.xlsx).'
    );
  });
});
