import type { FieldMeta, FieldTypeName } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FieldEditor, type FieldEditorTarget } from './FieldEditor';

const NOW = '2026-10-25T10:00:00.000Z';
const TABLE = '0190a000-0000-7000-8000-000000000999';
let n = 0;
const field = (type: FieldTypeName, options: unknown = {}, name = 'Field'): FieldMeta => ({
  id: `0190a000-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  tableId: TABLE,
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => vi.unstubAllGlobals());

/** Renders the editor over a fetch that answers writes with the field and queries with `values`. */
function setup(target: FieldEditorTarget, fields: FieldMeta[], values: unknown[] = []) {
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/records/query')) {
        const id = target.mode === 'edit' ? target.field.id : '';
        return json({
          records: values.map((v, i) => ({
            id: `0190a000-0000-7000-8000-${String(500 + i).padStart(12, '0')}`,
            tableId: TABLE,
            version: 1,
            fields: { [id]: v },
            createdAt: NOW,
            updatedAt: NOW,
            createdBy: null,
            updatedBy: null,
          })),
          offset: 0,
          total: values.length,
          nextCursor: null,
        });
      }
      requests.push({ method, path, body });
      const base = target.mode === 'edit' ? target.field : field('singleLineText');
      return json({ ...base, ...body }, method === 'POST' ? 201 : 200);
    })
  );
  const onDone = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <FieldEditor tableId={TABLE} fields={fields} target={target} onDone={onDone} />
    </QueryClientProvider>
  );
  return { requests, onDone, user: userEvent.setup() };
}

describe('FieldEditor: create', () => {
  it('creates a field with a name, a picked type and its options', async () => {
    const { requests, onDone, user } = setup({ mode: 'create', position: 2.5 }, []);
    await user.type(screen.getByLabelText('Field name'), 'Estimate');
    await user.type(screen.getByRole('combobox', { name: 'Search field types' }), 'numb');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Number',
      'Phone number',
      'Autonumber',
    ]);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('option', { name: 'Number' }).getAttribute('aria-selected')).toBe(
      'true'
    );
    await user.selectOptions(screen.getByLabelText('Decimal places'), '2 (1.00)');
    await user.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(requests).toEqual([
      {
        method: 'POST',
        path: `/api/tables/${TABLE}/fields`,
        body: {
          name: 'Estimate',
          type: 'number',
          options: { precision: 2, allowNegative: true },
          position: 2.5,
        },
      },
    ]);
  });

  it('refuses a name another field uses, without a request', async () => {
    const { requests, user } = setup({ mode: 'create' }, [field('number', {}, 'Estimate')]);
    await user.type(screen.getByLabelText('Field name'), 'estimate{Control>}{Enter}{/Control}');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'A field named "estimate" already exists'
    );
    expect(requests).toEqual([]);
  });

  it('edits select choices: add, rename, recolour, reorder and remove', async () => {
    const { requests, user } = setup({ mode: 'create' }, []);
    await user.type(screen.getByLabelText('Field name'), 'Stage');
    await user.click(screen.getByRole('option', { name: 'Single select' }));
    await user.click(screen.getByRole('button', { name: 'Add choice' }));
    await user.keyboard('Todo{Enter}Done{Enter}Later');
    const choices = () => within(screen.getByRole('list', { name: 'Choices' }));
    expect(
      choices()
        .getAllByRole('textbox')
        .map((i) => (i as HTMLInputElement).value)
    ).toEqual(['Todo', 'Done', 'Later']);
    // Alt+↑ moves "Later" above "Done"; remove "Todo"; recolour "Done".
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await user.click(screen.getByRole('button', { name: 'Remove Todo' }));
    await user.click(screen.getByRole('button', { name: /^Color of Done/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Violet' }));
    await user.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    const options = requests[0]?.body['options'] as { choices: { name: string; color: string }[] };
    expect(options.choices.map((c) => [c.name, c.color])).toEqual([
      ['Later', 'blue'],
      ['Done', 'violet'],
    ]);
  });
});

describe('FieldEditor: edit', () => {
  it('previews a lossy type change and warns before saving it', async () => {
    const notes = field('singleLineText', {}, 'Notes');
    const { requests, onDone, user } = setup(
      { mode: 'edit', field: notes, focus: 'type' },
      [notes],
      ['12', 'abc', null, '7.5']
    );
    await user.keyboard('number{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      '1 value will be cleared and 1 value will change in 4 records'
    );
    const examples = within(screen.getByRole('list', { name: 'Examples' })).getAllByRole(
      'listitem'
    );
    expect(examples[0]?.textContent).toContain('abc');
    expect(examples[0]?.textContent).toContain('Empty');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(requests).toEqual([
      {
        method: 'PATCH',
        path: `/api/fields/${notes.id}`,
        body: { type: 'number', options: { precision: 0, allowNegative: true } },
      },
    ]);
  });

  it('says a lossless conversion keeps every value', async () => {
    const notes = field('singleLineText', {}, 'Notes');
    const { user } = setup({ mode: 'edit', field: notes, focus: 'type' }, [notes], ['a', 'b']);
    await user.click(screen.getByRole('option', { name: 'Long text' }));
    expect(await screen.findByText('All 2 values in 2 records convert without loss.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warns when removing a choice that cells use', async () => {
    const stage = field('singleSelect', {
      choices: [
        { id: 'a', name: 'Todo', color: 'green' },
        { id: 'b', name: 'Done', color: 'amber' },
      ],
    });
    const { user } = setup({ mode: 'edit', field: stage }, [stage], ['a', 'b', 'b']);
    await user.click(screen.getByRole('button', { name: 'Remove Done' }));
    expect((await screen.findByRole('alert')).textContent).toContain('2 values will be cleared');
  });

  it('renames and describes with only the changed keys', async () => {
    const est = field('number', { precision: 1 }, 'Estimate');
    const { requests, user } = setup({ mode: 'edit', field: est, focus: 'description' }, [est]);
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Points');
    await user.clear(screen.getByLabelText('Field name'));
    await user.type(screen.getByLabelText('Field name'), 'Points{Control>}{Enter}{/Control}');
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body).toEqual({ name: 'Points', description: 'Points' });
  });

  it('closes without a request when nothing changed', async () => {
    const est = field('number', {}, 'Estimate');
    const { requests, onDone, user } = setup({ mode: 'edit', field: est }, [est]);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onDone).toHaveBeenCalledWith(est);
    expect(requests).toEqual([]);
  });
});
