import type * as Readline from 'node:readline';
import type * as Vm from 'node:vm';

/**
 * The runner: what the sandbox runs, as `node -e <RUNNER_SOURCE>`. It is never called in
 * the server's process: runnerMain is serialized with Function.prototype.toString, so it must be
 * self-contained (no imports, no closures over this module, nothing tsc would add a helper for).
 *
 * Protocol, JSON lines over stdio. The server writes `{ type: 'start', script, config, base,
 * limits }` first, then `{ type: 'result', id, ok, value | error }` answers. The runner writes
 * `{ type: 'call', id, method, args }`, `{ type: 'log', level, text }` and finally one of
 * `{ type: 'done', output }` or `{ type: 'error', message, line }`.
 *
 * The user's script runs in a fresh `vm` context with only `input`, `output`, `base`, `fetch`
 * and `console` besides the language's own globals (no `require`, `process`, timers or
 * `Buffer`), and node runs with `--disallow-code-generation-from-strings`, so the usual
 * `this.constructor.constructor('return process')()` escape throws. The context isn't the
 * security boundary, though: the container is (no network, read-only, no capabilities, limits).
 */
export function runnerMain(nodeRequire: (id: string) => unknown, proc: NodeJS.Process): void {
  const vm = nodeRequire('node:vm') as typeof Vm;
  const readline = nodeRequire('node:readline') as typeof Readline;
  const MAX_TEXT = 2000;
  const MAX_OUTPUT = 64 * 1024;

  type Json = Record<string, unknown>;
  type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
  type TableInfo = {
    id: string;
    name: string;
    fields: { id: string; name: string; type: string }[];
  };
  type Start = {
    script: string;
    config: Json;
    base: { id: string; name: string; tables: TableInfo[] };
  };
  type RecordData = { id: string; createdAt: string; updatedAt: string; fields: Json };

  const send = (message: Json, then?: () => void) => {
    proc.stdout.write(`${JSON.stringify(message)}\n`, then);
  };
  const finish = (message: Json) => {
    send(message, () => proc.exit(0));
  };
  // Errors the script sees come from its own realm, so `err instanceof Error` holds there.
  let ScriptError: ErrorConstructor = Error;
  const pending = new Map<number, Pending>();
  let seq = 0;
  const call = (method: string, args: Json): Promise<unknown> =>
    new Promise((resolve, reject) => {
      seq += 1;
      pending.set(seq, { resolve, reject });
      send({ type: 'call', id: seq, method, args });
    });

  const text = (value: unknown): string => {
    if (typeof value === 'string') return value;
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };
  // The server keeps 200 lines (32 KB); the rest isn't even sent, so a flood can't pile up in
  // the pipe's buffer.
  let logLines = 0;
  let logBytes = 0;
  const log =
    (level: string) =>
    (...args: unknown[]) => {
      if (logLines > 200 || logBytes > 32 * 1024) return;
      const line = args.map(text).join(' ').slice(0, MAX_TEXT);
      logLines += 1;
      logBytes += line.length;
      send({ type: 'log', level, text: line });
    };

  const plain = (value: unknown): unknown =>
    value === undefined ? null : JSON.parse(JSON.stringify(value));

  const wrapRecord = (r: RecordData) => ({
    id: r.id,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    fields: r.fields,
    getCellValue: (field: string) => r.fields[field] ?? null,
    getCellValueAsString: (field: string) => {
      const v = r.fields[field];
      if (v === null || v === undefined) return '';
      return typeof v === 'string' ? v : text(v);
    },
  });

  const idOf = (record: unknown): unknown =>
    record && typeof record === 'object' && 'id' in record
      ? (record as { id: unknown }).id
      : record;

  const tableApi = (t: TableInfo) =>
    Object.freeze({
      id: t.id,
      name: t.name,
      fields: t.fields.map((f) => Object.freeze({ ...f })),
      getField(nameOrId: string) {
        const f = t.fields.find((x) => x.id === nameOrId || x.name === nameOrId);
        if (!f) throw new ScriptError(`No field "${nameOrId}" in ${t.name}.`);
        return Object.freeze({ ...f });
      },
      async selectRecordsAsync(options: Json = {}) {
        const res = (await call('select', { tableId: t.id, ...(plain(options) as Json) })) as {
          records: RecordData[];
        };
        const records = res.records.map(wrapRecord);
        return {
          records,
          recordIds: records.map((r) => r.id),
          getRecord: (id: string) => records.find((r) => r.id === id) ?? null,
        };
      },
      async selectRecordAsync(id: string) {
        const r = (await call('get', { tableId: t.id, recordId: id })) as RecordData | null;
        return r ? wrapRecord(r) : null;
      },
      async createRecordAsync(fields: Json) {
        const res = (await call('create', {
          tableId: t.id,
          records: [{ fields: plain(fields) }],
        })) as { ids: string[] };
        return res.ids[0];
      },
      async createRecordsAsync(list: { fields: Json }[]) {
        const res = (await call('create', { tableId: t.id, records: plain(list) })) as {
          ids: string[];
        };
        return res.ids;
      },
      async updateRecordAsync(record: unknown, fields: Json) {
        await call('update', {
          tableId: t.id,
          records: [{ id: idOf(record), fields: plain(fields) }],
        });
      },
      async updateRecordsAsync(list: { id: string; fields: Json }[]) {
        await call('update', { tableId: t.id, records: plain(list) });
      },
      async deleteRecordAsync(record: unknown) {
        await call('delete', { tableId: t.id, recordIds: [idOf(record)] });
      },
      async deleteRecordsAsync(list: unknown[]) {
        await call('delete', { tableId: t.id, recordIds: list.map(idOf) });
      },
    });

  const start = (s: Start) => {
    const tables = s.base.tables.map(tableApi);
    const base = Object.freeze({
      id: s.base.id,
      name: s.base.name,
      tables,
      getTable(nameOrId: string) {
        const t = tables.find((x) => x.id === nameOrId || x.name === nameOrId);
        if (!t) throw new ScriptError(`No table "${nameOrId}" in this base.`);
        return t;
      },
    });
    const config = s.config;
    const input = Object.freeze({ config: () => plain(config) });
    const outputs: Json = {};
    const output = Object.freeze({
      set(key: string, value: unknown) {
        const k = String(key);
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
          throw new ScriptError(`"${k}" can't be an output name.`);
        }
        outputs[k] = plain(value);
        if (JSON.stringify(outputs).length > MAX_OUTPUT) {
          throw new ScriptError('The output is larger than 64 KB.');
        }
      },
    });
    const fetchApi = async (url: unknown, init: Json = {}) => {
      const res = (await call('fetch', {
        url: String(url),
        method: init['method'] ?? 'GET',
        headers: plain(init['headers'] ?? {}),
        body: init['body'] === undefined ? null : String(init['body']),
      })) as { status: number; statusText: string; headers: Record<string, string>; body: string };
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: res.statusText,
        url: String(url),
        headers: Object.freeze({
          get: (name: string) => res.headers[String(name).toLowerCase()] ?? null,
        }),
        text: async () => res.body,
        json: async () => JSON.parse(res.body),
      };
    };
    const console = Object.freeze({
      log: log('log'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    });
    const context = vm.createContext(
      { input, output, base, fetch: fetchApi, console },
      { codeGeneration: { strings: false, wasm: false }, name: 'script' }
    );
    ScriptError = vm.runInContext('Error', context) as ErrorConstructor;
    let fn: () => Promise<unknown>;
    try {
      const compiled = new vm.Script(`(async function () {\n${s.script}\n})`, {
        filename: 'script.js',
        lineOffset: -1,
      });
      fn = compiled.runInContext(context) as () => Promise<unknown>;
    } catch (err) {
      finish({ type: 'error', ...describe(err) });
      return;
    }
    Promise.resolve()
      .then(() => fn())
      .then(
        () => finish({ type: 'done', output: outputs }),
        (err: unknown) => finish({ type: 'error', ...describe(err) })
      );
  };

  /** An error's message and the script's line it came from. */
  const describe = (err: unknown): Json => {
    const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
    const name = e && typeof e.name === 'string' ? e.name : 'Error';
    const message = e && typeof e.message === 'string' ? e.message : text(err);
    const stack = e && typeof e.stack === 'string' ? e.stack : '';
    const line = /script\.js:(\d+)/.exec(stack);
    return {
      message: `${name}: ${message}`.slice(0, MAX_TEXT),
      line: line ? Number(line[1]) : null,
    };
  };

  let started = false;
  const rl = readline.createInterface({ input: proc.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  rl.on('line', (line: string) => {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    if (!started) {
      started = true;
      start(message as unknown as Start);
      return;
    }
    if (message['type'] !== 'result') return;
    const p = pending.get(message['id'] as number);
    if (!p) return;
    pending.delete(message['id'] as number);
    if (message['ok'] === true) p.resolve(message['value']);
    else p.reject(new ScriptError(String(message['error'] ?? 'The call failed.')));
  });
  rl.on('close', () => proc.exit(2));
}

/**
 * `node -e` source: CommonJS, so `require` and `process` are the runner's. `__name` is esbuild's
 * keep-names helper (tsx and Vitest run this file through esbuild; tsc adds nothing).
 */
export const RUNNER_SOURCE = `var __name = (f) => f;\n(${runnerMain.toString()})(require, process);`;
