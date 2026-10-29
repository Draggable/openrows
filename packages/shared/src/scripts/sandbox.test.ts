import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import {
  type SandboxMessage,
  SCRIPT_RUN_LIMITS,
  type ScriptStart,
  sandboxMessageSchema,
  scriptCallArgsSchemas,
} from './protocol.js';
import { SAMPLE_SCRIPTS } from './samples.js';
import { sandboxDocument, sandboxFrameScript, scriptWorkerMain } from './sandbox.js';

const T = '01900000-0000-7000-8000-000000000001';
const NAME = '01900000-0000-7000-8000-000000000002';
const QTY = '01900000-0000-7000-8000-000000000003';
const VIEW = '01900000-0000-7000-8000-000000000004';
const R1 = '01900000-0000-7000-8000-0000000000a1';
const R2 = '01900000-0000-7000-8000-0000000000a2';

const START: Omit<ScriptStart, 'code'> = {
  type: 'start',
  base: {
    id: '01900000-0000-7000-8000-000000000000',
    name: 'Shop',
    tables: [
      {
        id: T,
        name: 'Items',
        description: null,
        primaryFieldId: NAME,
        fields: [
          {
            id: NAME,
            name: 'Name',
            type: 'singleLineText',
            description: null,
            options: {},
            isComputed: false,
          },
          {
            id: QTY,
            name: 'Qty',
            type: 'number',
            description: null,
            options: {},
            isComputed: false,
          },
        ],
        views: [{ id: VIEW, name: 'Grid', type: 'grid' }],
      },
    ],
  },
  session: { currentUser: { id: 'u', name: 'Ada', email: 'ada@example.test' } },
  limits: SCRIPT_RUN_LIMITS,
};

const record = (id: string, name: string, qty: number) => ({
  id,
  name,
  createdTime: '2026-10-28T10:00:00.000Z',
  cells: { [NAME]: name, [QTY]: qty },
  strings: { [NAME]: name, [QTY]: String(qty) },
});

type Answer = (method: string, args: unknown) => unknown;

/**
 * Runs the worker's runtime in this process on a real MessageChannel, answering calls with
 * `answer` (throwing: a refused call). Resolves with every message, the last being done/error.
 */
function run(code: string, answer: Answer = () => null): Promise<SandboxMessage[]> {
  const scope: { onmessage: ((e: { data: unknown; ports: readonly unknown[] }) => void) | null } = {
    onmessage: null,
  };
  scriptWorkerMain(scope as never);
  const { port1, port2 } = new MessageChannel();
  const messages: SandboxMessage[] = [];
  return new Promise((resolve, reject) => {
    port1.on('message', async (raw: unknown) => {
      const parsed = sandboxMessageSchema.safeParse(raw);
      if (!parsed.success) {
        reject(new Error(`bad message ${JSON.stringify(raw)}`));
        return;
      }
      const m = parsed.data;
      messages.push(m);
      if (m.type === 'call') {
        try {
          const value = await answer(m.method, m.args);
          port1.postMessage({ type: 'result', id: m.id, ok: true, value });
        } catch (err) {
          port1.postMessage({ type: 'result', id: m.id, ok: false, error: String(err) });
        }
      }
      if (m.type === 'done' || m.type === 'error') {
        port1.close();
        resolve(messages);
      }
    });
    // The node port speaks `.on('message')`; the runtime sets `onmessage` with `{ data }`.
    const port = port2 as MessagePort & { onmessage: unknown };
    scope.onmessage?.({ data: { ...START, code }, ports: [port] });
  });
}

const last = (messages: SandboxMessage[]) => messages[messages.length - 1];
const calls = (messages: SandboxMessage[]) =>
  messages.flatMap((m) => (m.type === 'call' ? [{ method: m.method, args: m.args }] : []));

describe('the script runtime (#152)', () => {
  it('runs a script with the base, output and session', async () => {
    const messages = await run(
      [
        "const t = base.getTable('Items');",
        "output.text(t.name + ' ' + t.fields.map((f) => f.name).join(','));",
        "output.markdown('**' + session.currentUser.name + '**');",
        "console.log('hi', { a: 1 });",
      ].join('\n')
    );
    expect(messages).toEqual([
      { type: 'output', kind: 'text', text: 'Items Name,Qty' },
      { type: 'output', kind: 'markdown', text: '**Ada**' },
      { type: 'log', level: 'log', text: 'hi {\n  "a": 1\n}' },
      { type: 'done' },
    ]);
  });

  it('selects records by field name and reads cells by name, id or field', async () => {
    const messages = await run(
      [
        "const t = base.getTable('Items');",
        "const q = await t.selectRecordsAsync({ fields: ['Qty'], sorts: [{ field: t.getField('Qty'), direction: 'desc' }] });",
        "output.text(q.records.map((r) => r.name + '=' + r.getCellValue('Qty')).join(';'));",
        `output.text(q.getRecord('${R2}').getCellValueAsString(t.getField('${QTY}')));`,
      ].join('\n'),
      () => ({ records: [record(R1, 'Pen', 3), record(R2, 'Ink', 1)] })
    );
    expect(calls(messages)).toEqual([
      {
        method: 'select',
        args: { tableId: T, fieldIds: [QTY], sorts: [{ fieldId: QTY, direction: 'desc' }] },
      },
    ]);
    expect(scriptCallArgsSchemas.select.safeParse(calls(messages)[0]?.args).success).toBe(true);
    expect(messages.filter((m) => m.type === 'output')).toEqual([
      { type: 'output', kind: 'text', text: 'Pen=3;Ink=1' },
      { type: 'output', kind: 'text', text: '1' },
    ]);
    expect(last(messages)).toEqual({ type: 'done' });
  });

  it('writes cells keyed by field id, in batches of at most 50', async () => {
    const messages = await run(
      [
        "const t = base.getTable('Items');",
        "const ids = await t.createRecordsAsync([{ fields: { Name: 'A', Qty: 2 } }]);",
        `await t.updateRecordAsync('${R1}', { '${QTY}': 5 });`,
        `await t.deleteRecordsAsync([{ id: '${R1}' }, '${R2}']);`,
        'output.text(ids.join());',
        'const many = Array.from({ length: 51 }, () => ({ fields: {} }));',
        'await t.createRecordsAsync(many);',
      ].join('\n'),
      (method) => (method === 'create' ? { ids: [R1] } : null)
    );
    expect(calls(messages)).toEqual([
      { method: 'create', args: { tableId: T, records: [{ fields: { [NAME]: 'A', [QTY]: 2 } }] } },
      { method: 'update', args: { tableId: T, records: [{ id: R1, fields: { [QTY]: 5 } }] } },
      { method: 'delete', args: { tableId: T, recordIds: [R1, R2] } },
    ]);
    for (const c of calls(messages)) {
      const schema = scriptCallArgsSchemas[c.method as 'create' | 'update' | 'delete'];
      expect(schema.safeParse(c.args).success).toBe(true);
    }
    expect(last(messages)).toEqual({
      type: 'error',
      message: 'Error: At most 50 records per call.',
      line: 7,
    });
  });

  it("gives a refused call's error to the script, which may catch it", async () => {
    const messages = await run(
      [
        "const t = base.getTable('Items');",
        'try {',
        "  await t.createRecordAsync({ Name: 'x' });",
        '} catch (err) {',
        "  output.text('caught ' + err.message);",
        '}',
        'await t.deleteRecordAsync(1);',
      ].join('\n'),
      () => {
        throw new Error("You can't add records to this table.");
      }
    );
    expect(messages[1]).toEqual({
      type: 'output',
      kind: 'text',
      text: "caught Error: You can't add records to this table.",
    });
    expect(last(messages)).toMatchObject({ type: 'error', line: 7 });
  });

  it('reports unknown tables and fields, syntax errors and their lines', async () => {
    expect(last(await run("\n\nbase.getTable('Nope');"))).toEqual({
      type: 'error',
      message: 'Error: No table "Nope" in this base.',
      line: 3,
    });
    expect(last(await run("base.getTable('Items').getField('Missing')"))).toMatchObject({
      message: 'Error: No field "Missing" in Items.',
    });
    expect(last(await run('const x = ;'))).toMatchObject({ type: 'error' });
    expect(last(await run("throw new TypeError('boom')"))).toEqual({
      type: 'error',
      message: 'TypeError: boom',
      line: 1,
    });
  });

  it('shapes output.table from objects, values and records', async () => {
    const messages = await run(
      [
        "output.table([{ a: 1, b: 'x' }, { a: 2, c: null }]);",
        "output.table(['one', 'two']);",
        'output.table({ total: 3 });',
      ].join('\n')
    );
    expect(messages.slice(0, 3)).toEqual([
      {
        type: 'output',
        kind: 'table',
        columns: ['a', 'b', 'c'],
        rows: [
          ['1', 'x', ''],
          ['2', '', ''],
        ],
      },
      { type: 'output', kind: 'table', columns: ['Value'], rows: [['one'], ['two']] },
      { type: 'output', kind: 'table', columns: ['Key', 'Value'], rows: [['total', '3']] },
    ]);
  });

  it('asks for input through calls and answers with the API objects', async () => {
    const messages = await run(
      [
        "const name = await input.textAsync('Your name');",
        "const t = await input.tableAsync('Table');",
        "const f = await input.fieldAsync('Field', t);",
        "const pick = await input.buttonsAsync('Go?', [{ label: 'Yes', value: 42, variant: 'primary' }, 'No']);",
        "const r = await input.recordAsync('Record', t.getView('Grid'));",
        "output.text([name, t.name, f.name, pick, r.name].join('|'));",
      ].join('\n'),
      (_method, args) => {
        const kind = (args as { kind: string }).kind;
        if (kind === 'text') return 'Ada';
        if (kind === 'table') return T;
        if (kind === 'field') return QTY;
        if (kind === 'buttons') return 0;
        return record(R1, 'Pen', 3);
      }
    );
    const inputs = calls(messages).map((c) => c.args);
    expect(inputs).toEqual([
      { kind: 'text', label: 'Your name' },
      { kind: 'table', label: 'Table' },
      { kind: 'field', label: 'Field', tableId: T },
      {
        kind: 'buttons',
        label: 'Go?',
        options: [{ label: 'Yes', variant: 'primary' }, { label: 'No' }],
      },
      { kind: 'record', label: 'Record', tableId: T, viewId: VIEW },
    ]);
    for (const args of inputs)
      expect(scriptCallArgsSchemas.input.safeParse(args).success).toBe(true);
    expect(messages.find((m) => m.type === 'output')).toEqual({
      type: 'output',
      kind: 'text',
      text: 'Ada|Items|Qty|42|Pen',
    });
  });

  it('has no fetch of its own to the outside', async () => {
    expect(last(await run('await remoteFetchAsync("https://example.test")'))).toMatchObject({
      type: 'error',
      message: "Error: remoteFetchAsync isn't available in OpenRows scripts yet.",
    });
  });

  it('runs the samples', async () => {
    const records = [record(R1, 'Pen', 3), record(R2, 'pen ', 1)];
    for (const sample of SAMPLE_SCRIPTS) {
      const messages = await run(sample.code, (method, args) => {
        if (method === 'select') return { records };
        if (method === 'delete' || method === 'update') return null;
        const kind = (args as { kind: string }).kind;
        if (kind === 'table') return T;
        if (kind === 'field') return NAME;
        if (kind === 'buttons') return 0;
        return 'Pen';
      });
      expect(last(messages), sample.key).toEqual({ type: 'done' });
      const writes = calls(messages).filter((c) => c.method === 'update' || c.method === 'delete');
      if (sample.key === 'dedupe') {
        expect(writes).toEqual([{ method: 'delete', args: { tableId: T, recordIds: [R2] } }]);
      }
      if (sample.key === 'bulkUpdate') {
        // "Pen" → "Pen" (replace with itself): the record still gets the same value back.
        expect(writes).toEqual([
          {
            method: 'update',
            args: { tableId: T, records: [{ id: R1, fields: { [NAME]: 'Pen' } }] },
          },
        ]);
      }
    }
  });
});

describe('the sandbox document', () => {
  it('is one inline script that closes no element early', () => {
    const script = sandboxFrameScript();
    expect(script).not.toMatch(/<\/?script/i);
    expect(() => new Function(script)).not.toThrow();
    const html = sandboxDocument(script);
    expect(html.match(/<script>/g)).toHaveLength(1);
  });
});

describe('sandbox messages', () => {
  it('refuses calls past the batch size and unknown message types', () => {
    const records = Array.from({ length: SCRIPT_RUN_LIMITS.maxWriteBatch + 1 }, () => ({
      fields: {},
    }));
    expect(scriptCallArgsSchemas.create.safeParse({ tableId: T, records }).success).toBe(false);
    expect(scriptCallArgsSchemas.update.safeParse({ tableId: T, records: [] }).success).toBe(false);
    expect(
      scriptCallArgsSchemas.select.safeParse({ tableId: 'not-an-id', fieldIds: [] }).success
    ).toBe(false);
    expect(sandboxMessageSchema.safeParse({ type: 'eval', code: '1' }).success).toBe(false);
    expect(
      sandboxMessageSchema.safeParse({ type: 'call', id: 1, method: 'fetch', args: {} }).success
    ).toBe(false);
  });
});
