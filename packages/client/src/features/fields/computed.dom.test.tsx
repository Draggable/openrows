import type { FieldMeta, FieldTypeName } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FieldEditor, type FieldEditorTarget } from './FieldEditor';

// The field editor's options for lookup, rollup and count.

const NOW = '2026-10-25T10:00:00.000Z';
const TASKS = '0190a000-0000-7000-8000-000000000901';
const PROJECTS = '0190a000-0000-7000-8000-000000000902';
let n = 0;
const field = (
  tableId: string,
  type: FieldTypeName,
  name: string,
  options: unknown = {}
): FieldMeta => ({
  id: `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  tableId,
  name,
  description: null,
  type,
  options,
  isPrimary: false,
  position: n,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

const projectName = field(PROJECTS, 'singleLineText', 'Name');
const budget = field(PROJECTS, 'currency', 'Budget');
const taskName = field(TASKS, 'singleLineText', 'Title');
const projectLink = field(TASKS, 'link', 'Project', { linkedTableId: PROJECTS });
const TASK_FIELDS = [taskName, projectLink];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => vi.unstubAllGlobals());

/** The editor over a fetch serving the Projects table; writes answer `reply` (the field). */
function setup(
  target: FieldEditorTarget,
  fields: FieldMeta[] = TASK_FIELDS,
  reply?: () => Response
) {
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      if (method === 'GET' && path === `/api/tables/${PROJECTS}`) {
        return json({
          id: PROJECTS,
          baseId: '0190a000-0000-7000-8000-000000000900',
          name: 'Projects',
          description: null,
          icon: null,
          position: 1,
          schemaVersion: 1,
          fields: [projectName, budget],
          createdAt: NOW,
          updatedAt: NOW,
        });
      }
      if (path.endsWith('/records/query')) {
        const id = target.mode === 'edit' ? target.field.id : '';
        const records = ['first', 'second'].map((v, i) => ({
          id: `0190a000-0000-7000-8000-${String(700 + i).padStart(12, '0')}`,
          tableId: TASKS,
          version: 1,
          fields: { [id]: v },
          createdAt: NOW,
          updatedAt: NOW,
          createdBy: null,
          updatedBy: null,
        }));
        return json({ records, offset: 0, total: 2, nextCursor: null });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      writes.push({ method, path, body });
      if (reply) return reply();
      const base = target.mode === 'edit' ? target.field : field(TASKS, 'rollup', 'x');
      return json({ ...base, ...body }, method === 'POST' ? 201 : 200);
    })
  );
  const onDone = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <FieldEditor tableId={TASKS} fields={fields} target={target} onDone={onDone} />
    </QueryClientProvider>
  );
  return { writes, onDone, user: userEvent.setup() };
}

async function pickType(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.type(screen.getByRole('combobox', { name: 'Search field types' }), label);
  await user.click(screen.getByRole('option', { name: label }));
}

describe('FieldEditor: lookup, rollup and count (#82)', () => {
  it('offers them under Computed, next to Formula', async () => {
    setup({ mode: 'create' });
    const computed = screen.getByRole('group', { name: 'Computed' });
    const names = [...computed.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(['Lookup', 'Rollup', 'Count', 'Formula']));
  });

  it('creates a rollup: link field, field of the linked table, aggregation, decimals', async () => {
    const { writes, onDone, user } = setup({ mode: 'create' });
    await user.type(screen.getByLabelText('Field name'), 'Total budget');
    await pickType(user, 'Rollup');
    await user.selectOptions(screen.getByLabelText('Linked record field'), 'Project');
    const source = screen.getByLabelText('Field to roll up');
    await waitFor(() => expect(source.hasAttribute('disabled')).toBe(false));
    await user.selectOptions(source, 'Budget');
    expect(screen.queryByLabelText('Separator')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Decimal places'), '2 (1.00)');
    await user.selectOptions(screen.getByLabelText('Aggregation'), 'ARRAYJOIN');
    // Joined text: a separator, no decimals.
    expect(screen.queryByLabelText('Decimal places')).toBeNull();
    await user.clear(screen.getByLabelText('Separator'));
    await user.type(screen.getByLabelText('Separator'), ' / ');
    await user.selectOptions(screen.getByLabelText('Aggregation'), 'SUM');
    await user.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(writes).toEqual([
      {
        method: 'POST',
        path: `/api/tables/${TASKS}/fields`,
        body: {
          name: 'Total budget',
          type: 'rollup',
          options: {
            recordLinkFieldId: projectLink.id,
            fieldIdInLinkedTable: budget.id,
            function: 'SUM',
            separator: ' / ',
            precision: 2,
          },
        },
      },
    ]);
  });

  it('creates a lookup and a count', async () => {
    const lookup = setup({ mode: 'create' });
    await lookup.user.type(screen.getByLabelText('Field name'), 'Project names');
    await pickType(lookup.user, 'Lookup');
    await lookup.user.selectOptions(screen.getByLabelText('Linked record field'), 'Project');
    const source = screen.getByLabelText('Field to look up');
    await waitFor(() => expect(source.hasAttribute('disabled')).toBe(false));
    await lookup.user.selectOptions(source, 'Name');
    await lookup.user.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(lookup.onDone).toHaveBeenCalled());
    expect(lookup.writes[0]?.body).toMatchObject({
      type: 'lookup',
      options: { recordLinkFieldId: projectLink.id, fieldIdInLinkedTable: projectName.id },
    });
    document.body.innerHTML = '';

    const count = setup({ mode: 'create' });
    await count.user.type(screen.getByLabelText('Field name'), 'Projects');
    await pickType(count.user, 'Count');
    expect(screen.queryByLabelText(/Field to/)).toBeNull();
    await count.user.selectOptions(screen.getByLabelText('Linked record field'), 'Project');
    await count.user.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(count.onDone).toHaveBeenCalled());
    expect(count.writes[0]?.body).toMatchObject({
      type: 'count',
      options: { recordLinkFieldId: projectLink.id },
    });
  });

  it('asks for the missing options before any request', async () => {
    const { writes, user } = setup({ mode: 'create' });
    await user.type(screen.getByLabelText('Field name'), 'Names');
    await pickType(user, 'Lookup');
    await user.click(screen.getByRole('button', { name: 'Create field' }));
    expect(screen.getByRole('alert').textContent).toBe('Pick a linked record field');
    await user.selectOptions(screen.getByLabelText('Linked record field'), 'Project');
    await user.click(screen.getByRole('button', { name: 'Create field' }));
    expect(screen.getByRole('alert').textContent).toBe('Pick a field of the linked table');
    expect(writes).toEqual([]);
  });

  it('explains a table without link fields', async () => {
    const { user } = setup({ mode: 'create' }, [taskName]);
    await pickType(user, 'Count');
    expect(screen.getByText(/no linked record field yet/)).toBeTruthy();
  });

  it("shows the server's 422 problems inline", async () => {
    const { user } = setup({ mode: 'create' }, TASK_FIELDS, () =>
      json(
        {
          type: 'about:blank',
          title: 'Validation failed',
          status: 422,
          detail: 'The field options are invalid.',
          code: 'VALIDATION_FAILED',
          errors: [{ path: 'options.fieldIdInLinkedTable', message: 'Circular reference.' }],
        },
        422
      )
    );
    await user.type(screen.getByLabelText('Field name'), 'Loop');
    await pickType(user, 'Count');
    await user.selectOptions(screen.getByLabelText('Linked record field'), 'Project');
    await user.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Circular reference.'));
  });

  it('converts a text field into a count, with the conversion preview', async () => {
    const notes = field(TASKS, 'singleLineText', 'Notes');
    const { writes, onDone, user } = setup({ mode: 'edit', field: notes, focus: 'type' }, [
      ...TASK_FIELDS,
      notes,
    ]);
    await pickType(user, 'Count');
    await user.selectOptions(screen.getByLabelText('Linked record field'), 'Project');
    const preview = await screen.findByRole('region', { name: 'Conversion preview' });
    await waitFor(() =>
      expect(preview.textContent).toContain(
        'Count fills its own values: 2 values in 2 records will be discarded.'
      )
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(writes[0]).toMatchObject({
      method: 'PATCH',
      path: `/api/fields/${notes.id}`,
      body: { type: 'count', options: { recordLinkFieldId: projectLink.id } },
    });
  });
});
