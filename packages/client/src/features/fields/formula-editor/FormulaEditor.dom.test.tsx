import { acceptCompletion, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import type { FieldMeta, FieldTypeName } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FieldEditor, type FieldEditorTarget } from '../FieldEditor';

const NOW = '2026-10-25T10:00:00.000Z';
const TABLE = '0190a000-0000-7000-8000-000000000999';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const field = (n: number, name: string, type: FieldTypeName, options: unknown = {}): FieldMeta => ({
  id: id(n),
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
const PRICE = field(2, 'Price', 'currency', { precision: 2 });
const QTY = field(3, 'Qty', 'number');
const FIELDS = [NAME, PRICE, QTY];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom has no layout; CodeMirror measures ranges.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});
afterEach(() => vi.unstubAllGlobals());

async function setup(target: FieldEditorTarget, fields: FieldMeta[] = FIELDS) {
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/records/query')) {
        return json({
          records: [
            {
              id: id(500),
              tableId: TABLE,
              version: 1,
              fields: { [NAME.id]: 'Desk', [PRICE.id]: 12.5, [QTY.id]: 3 },
              createdAt: NOW,
              updatedAt: NOW,
              createdBy: null,
              updatedBy: null,
            },
          ],
          offset: 0,
          total: 1,
          nextCursor: null,
        });
      }
      requests.push({ method, path, body });
      const base = target.mode === 'edit' ? target.field : field(99, 'New', 'formula');
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
  const content = await screen.findByRole('textbox', { name: 'Formula' });
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error('no editor');
  /** Types at the cursor, as the user would (so completion activates). */
  const type = (text: string) =>
    act(() => {
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type' });
    });
  const setText = (text: string) =>
    act(() => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
        userEvent: 'input.type',
      });
    });
  return { requests, onDone, view, content, type, setText, user: userEvent.setup() };
}

/** Accepts the selected completion (CodeMirror ignores it for 75 ms after the list opens). */
const accept = (view: EditorView, expected: string) =>
  waitFor(() => {
    act(() => {
      acceptCompletion(view);
    });
    expect(view.state.doc.toString()).toBe(expected);
  });

const create = (formula = ''): FieldEditorTarget => ({
  mode: 'create',
  initial: { name: 'Total', type: 'formula', options: { formula }, description: '' },
});

describe('FormulaEditor in the field editor', () => {
  it('is labelled, offered by the type picker and previews the first record', async () => {
    const { user } = await setup(create('{Price} * Qty'));
    await user.type(screen.getByRole('combobox', { name: 'Search field types' }), 'formu');
    expect(screen.getByRole('option', { name: 'Formula' })).toBeTruthy();
    const dl = screen.getByLabelText('Formula preview');
    expect(within(dl).getByText('Number')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('formula-preview').textContent).toBe('37.5'));
  });

  it('saves the stored form (fields by id) and its options', async () => {
    const { requests, user } = await setup(create('{Price} * Qty'));
    await user.click(screen.getByRole('button', { name: 'Create field' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body).toMatchObject({
      name: 'Total',
      type: 'formula',
      options: { formula: `{${PRICE.id}} * {${QTY.id}}` },
    });
  });

  it('shows type errors inline at their range and blocks saving', async () => {
    const { setText, view, content, requests, user } = await setup(create('1'));
    setText('{Name} * 2');
    const errors = await screen.findByRole('list', { name: 'Formula errors' });
    expect(errors.textContent).toMatch(/“\{Name\}”/);
    expect(content.getAttribute('aria-describedby')).toContain(errors.parentElement?.id ?? 'x');
    const mark = view.dom.querySelector('.cm-lintRange-error');
    expect(mark?.textContent).toBe('{Name}');
    const save = screen.getByRole('button', { name: 'Create field' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Ctrl Enter doesn't get past the check either.
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(requests).toHaveLength(0);
    expect(screen.queryByLabelText('Formula preview')).toBeNull();

    setText('UPPER({Name})');
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Formula errors' })).toBeNull());
    expect(save.disabled).toBe(false);
    expect(view.dom.querySelector('.cm-lintRange-error')).toBeNull();
  });

  it('reports syntax errors and unknown functions', async () => {
    const { setText } = await setup(create('1'));
    setText('NOPE(1) + (');
    const errors = await screen.findByRole('list', { name: 'Formula errors' });
    expect(errors.textContent).toMatch(/at the end/);
    setText('NOPE(1)');
    expect((await screen.findByRole('list', { name: 'Formula errors' })).textContent).toMatch(
      /“NOPE”/
    );
  });

  it('completes field names and inserts them as references', async () => {
    const { type, view } = await setup(create(''));
    type('{Pr');
    await waitFor(() =>
      expect(currentCompletions(view.state).map((c) => c.displayLabel ?? c.label)).toContain(
        'Price'
      )
    );
    await accept(view, '{Price}');
  });

  it('completes functions with their signature and description, then helps with arguments', async () => {
    const { type, view } = await setup(create(''));
    type('ROUN');
    await waitFor(() => expect(currentCompletions(view.state)[0]?.label).toBe('ROUND'));
    const round = currentCompletions(view.state)[0];
    expect(round?.detail).toBe('(number, [number])');
    expect(round?.info).toBe('Rounds to a number of decimals');
    await accept(view, 'ROUND()');
    expect(view.state.selection.main.head).toBe(6);
    const help = await screen.findByText('Rounds to a number of decimals');
    expect(help.textContent).toContain('ROUND(number, [number])');
    type('{Price}, ');
    await waitFor(() => expect(help.querySelector('.underline')?.textContent).toBe('[number]'));
  });

  it('offers every field and function on request (Ctrl Space)', async () => {
    const { view } = await setup(create(''));
    act(() => {
      startCompletion(view);
    });
    await waitFor(() => expect(currentCompletions(view.state).length).toBeGreaterThan(80));
    const labels = currentCompletions(view.state).map((c) => c.displayLabel ?? c.label);
    expect(labels).toEqual(expect.arrayContaining(['Name', 'Price', 'Qty', 'IF', 'DATEADD']));
  });

  it('edits a saved formula with the current names and saves nothing when unchanged', async () => {
    const total = field(4, 'Total', 'formula', {
      formula: `{${PRICE.id}} * {${QTY.id}}`,
      resultType: 'number',
      referencedFieldIds: [PRICE.id, QTY.id],
      isValid: true,
      precision: null,
      timeZone: 'UTC',
    });
    const { view, requests, onDone, user } = await setup({ mode: 'edit', field: total }, [
      ...FIELDS,
      total,
    ]);
    expect(view.state.doc.toString()).toBe('{Price} * {Qty}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(requests).toHaveLength(0);
    expect(onDone).toHaveBeenCalledWith(total);
    // The number formatting shows for a number result.
    expect(screen.getByLabelText('Decimal places')).toBeTruthy();
  });
});
