/**
 * Browser scripts: what runs inside the sandbox. Both functions are serialized with
 * Function.prototype.toString into the sandbox document (`sandboxFrameScript`), so they must be
 * self-contained: no imports, no closures over this module, nothing tsc would add a helper for.
 * protocol.ts describes the messages.
 */

// The few worker globals the runtime uses (shared builds without the DOM library).
interface WorkerPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}
interface WorkerScope {
  onmessage: ((event: { data: unknown; ports: readonly WorkerPort[] }) => void) | null;
}

/**
 * The worker: waits for the start message and its port, builds the Airtable-like API (`base`,
 * `input`, `output`, `session`, `console`) and runs the script as the body of an async function.
 * Calls are answered by the host; the worker only shapes them.
 */
export function scriptWorkerMain(scope: WorkerScope): void {
  type Json = Record<string, unknown>;
  type FieldInfo = {
    id: string;
    name: string;
    type: string;
    description: string | null;
    options: unknown;
    isComputed: boolean;
  };
  type TableInfo = {
    id: string;
    name: string;
    description: string | null;
    primaryFieldId: string | null;
    fields: FieldInfo[];
    views: { id: string; name: string; type: string }[];
  };
  type RecordData = {
    id: string;
    name: string;
    createdTime: string;
    cells: Json;
    strings: Record<string, string>;
  };
  type Start = {
    code: string;
    base: { id: string; name: string; tables: TableInfo[] };
    session: { currentUser: unknown };
    limits: { maxWriteBatch: number; maxOutputChars: number; maxTableRows: number };
  };
  // `site`: where the script made the call, so a refused call's error names the script's line.
  type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; site: Error };

  let port: WorkerPort | null = null;
  const pending = new Map<number, Pending>();
  let seq = 0;
  const send = (message: Json) => port?.postMessage(message);

  const call = (method: string, args: Json): Promise<unknown> =>
    new Promise((resolve, reject) => {
      seq += 1;
      pending.set(seq, { resolve, reject, site: new Error() });
      send({ type: 'call', id: seq, method, args });
    });

  const text = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      const json = JSON.stringify(value, null, 2);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };

  const start = (s: Start) => {
    const maxChars = s.limits.maxOutputChars;
    const clip = (t: string) => (t.length > maxChars ? `${t.slice(0, maxChars)}…` : t);

    const tableById = new Map(s.base.tables.map((t) => [t.id, t]));
    const findIn = <T extends { id: string; name: string }>(list: T[], key: unknown) => {
      if (key && typeof key === 'object' && 'id' in key) {
        return list.find((x) => x.id === (key as { id: unknown }).id) ?? null;
      }
      if (typeof key !== 'string') return null;
      return list.find((x) => x.id === key) ?? list.find((x) => x.name === key) ?? null;
    };
    const idOf = (record: unknown): unknown =>
      record && typeof record === 'object' && 'id' in record
        ? (record as { id: unknown }).id
        : record;

    const fieldApi = (f: FieldInfo) =>
      Object.freeze({
        id: f.id,
        name: f.name,
        type: f.type,
        description: f.description,
        options: f.options === undefined ? null : JSON.parse(JSON.stringify(f.options)),
        isComputed: f.isComputed,
      });

    const recordApi = (t: TableInfo, r: RecordData) => {
      const fieldOf = (key: unknown): FieldInfo => {
        const f = findIn(t.fields, key);
        if (!f) throw new Error(`No field "${text(key).slice(0, 100)}" in ${t.name}.`);
        return f;
      };
      return Object.freeze({
        id: r.id,
        name: r.name,
        createdTime: r.createdTime,
        getCellValue(field: unknown) {
          const v = r.cells[fieldOf(field).id];
          return v === undefined ? null : v;
        },
        getCellValueAsString(field: unknown) {
          return r.strings[fieldOf(field).id] ?? '';
        },
      });
    };

    const queryResult = (t: TableInfo, records: RecordData[]) => {
      const list = records.map((r) => recordApi(t, r));
      const byId = new Map(list.map((r) => [r.id, r]));
      return Object.freeze({
        records: list,
        recordIds: list.map((r) => r.id),
        getRecord(recordId: string) {
          const r = byId.get(recordId);
          if (!r) throw new Error(`No record "${text(recordId).slice(0, 100)}" in this result.`);
          return r;
        },
      });
    };

    const cellsById = (t: TableInfo, fields: unknown): Json => {
      if (!fields || typeof fields !== 'object') throw new Error('Pass the cells as an object.');
      const out: Json = {};
      for (const [k, v] of Object.entries(fields as Json)) {
        const f = findIn(t.fields, k);
        if (!f) throw new Error(`No field "${k.slice(0, 100)}" in ${t.name}.`);
        out[f.id] = v === undefined ? null : JSON.parse(JSON.stringify(v));
      }
      return out;
    };
    const batch = (list: unknown, what: string): unknown[] => {
      if (!Array.isArray(list)) throw new Error(`Pass an array of ${what}.`);
      if (list.length > s.limits.maxWriteBatch) {
        throw new Error(`At most ${s.limits.maxWriteBatch} ${what} per call.`);
      }
      return list;
    };

    type SelectOptions = { fields?: unknown[]; sorts?: { field: unknown; direction?: string }[] };
    const selectArgs = (t: TableInfo, options: SelectOptions & { recordIds?: unknown[] } = {}) => {
      const args: Json = { tableId: t.id };
      if (options.fields) {
        args['fieldIds'] = options.fields.map((f) => {
          const field = findIn(t.fields, f);
          if (!field) throw new Error(`No field "${text(f).slice(0, 100)}" in ${t.name}.`);
          return field.id;
        });
      }
      if (options.sorts) {
        args['sorts'] = options.sorts.map((sort) => {
          const field = findIn(t.fields, sort.field);
          if (!field) throw new Error(`No field "${text(sort.field).slice(0, 100)}" in ${t.name}.`);
          return { fieldId: field.id, direction: sort.direction === 'desc' ? 'desc' : 'asc' };
        });
      }
      if (options.recordIds) args['recordIds'] = options.recordIds.map(idOf);
      return args;
    };

    const viewApi = (t: TableInfo, v: { id: string; name: string; type: string }) =>
      Object.freeze({
        id: v.id,
        name: v.name,
        type: v.type,
        async selectRecordsAsync(options?: SelectOptions & { recordIds?: unknown[] }) {
          const res = (await call('select', { ...selectArgs(t, options), viewId: v.id })) as {
            records: RecordData[];
          };
          return queryResult(t, res.records);
        },
        async selectRecordAsync(recordId: string) {
          const res = (await call('select', {
            ...selectArgs(t, { recordIds: [recordId] }),
            viewId: v.id,
          })) as { records: RecordData[] };
          const r = res.records[0];
          return r ? recordApi(t, r) : null;
        },
      });

    const tableApi = (t: TableInfo) => {
      const fields = t.fields.map(fieldApi);
      const views = t.views.map((v) => viewApi(t, v));
      const primary = t.fields.find((f) => f.id === t.primaryFieldId);
      return Object.freeze({
        id: t.id,
        name: t.name,
        description: t.description,
        primaryField: primary ? fieldApi(primary) : null,
        fields,
        views,
        getFieldIfExists: (key: unknown) => findIn(fields, key),
        getField(key: unknown) {
          const f = findIn(fields, key);
          if (!f) throw new Error(`No field "${text(key).slice(0, 100)}" in ${t.name}.`);
          return f;
        },
        getViewIfExists: (key: unknown) => findIn(views, key),
        getView(key: unknown) {
          const v = findIn(views, key);
          if (!v) throw new Error(`No view "${text(key).slice(0, 100)}" in ${t.name}.`);
          return v;
        },
        async selectRecordsAsync(options?: SelectOptions & { recordIds?: unknown[] }) {
          const res = (await call('select', selectArgs(t, options))) as { records: RecordData[] };
          return queryResult(t, res.records);
        },
        async selectRecordAsync(recordId: unknown) {
          const r = (await call('get', {
            tableId: t.id,
            recordId: idOf(recordId),
          })) as RecordData | null;
          return r ? recordApi(t, r) : null;
        },
        async createRecordAsync(cells: unknown) {
          const res = (await call('create', {
            tableId: t.id,
            records: [{ fields: cellsById(t, cells) }],
          })) as { ids: string[] };
          return res.ids[0];
        },
        async createRecordsAsync(list: unknown) {
          const records = batch(list, 'records').map((r) => ({
            fields: cellsById(t, (r as { fields?: unknown })?.fields),
          }));
          if (records.length === 0) return [];
          const res = (await call('create', { tableId: t.id, records })) as { ids: string[] };
          return res.ids;
        },
        async updateRecordAsync(record: unknown, cells: unknown) {
          await call('update', {
            tableId: t.id,
            records: [{ id: idOf(record), fields: cellsById(t, cells) }],
          });
        },
        async updateRecordsAsync(list: unknown) {
          const records = batch(list, 'records').map((r) => ({
            id: (r as { id?: unknown })?.id,
            fields: cellsById(t, (r as { fields?: unknown })?.fields),
          }));
          if (records.length === 0) return;
          await call('update', { tableId: t.id, records });
        },
        async deleteRecordAsync(record: unknown) {
          await call('delete', { tableId: t.id, recordIds: [idOf(record)] });
        },
        async deleteRecordsAsync(list: unknown) {
          const recordIds = batch(list, 'records').map(idOf);
          if (recordIds.length === 0) return;
          await call('delete', { tableId: t.id, recordIds });
        },
      });
    };

    const tables = s.base.tables.map(tableApi);
    const tableOf = (key: unknown) => {
      const t = findIn(s.base.tables, key);
      if (!t) throw new Error(`No table "${text(key).slice(0, 100)}" in this base.`);
      return t;
    };
    const base = Object.freeze({
      id: s.base.id,
      name: s.base.name,
      tables,
      getTableIfExists: (key: unknown) => findIn(tables, key),
      getTable(key: unknown) {
        const t = findIn(tables, key);
        if (!t) throw new Error(`No table "${text(key).slice(0, 100)}" in this base.`);
        return t;
      },
    });
    const tableObject = (tableId: string) => tables.find((t) => t.id === tableId) ?? null;

    const output = Object.freeze({
      text(value: unknown) {
        send({ type: 'output', kind: 'text', text: clip(text(value)) });
      },
      markdown(value: unknown) {
        send({ type: 'output', kind: 'markdown', text: clip(text(value)) });
      },
      inspect(value: unknown) {
        send({ type: 'output', kind: 'inspect', text: clip(text(value)) });
      },
      clear() {
        send({ type: 'output', kind: 'clear' });
      },
      table(data: unknown) {
        const cell = (v: unknown) => {
          if (v === null || v === undefined) return '';
          if (v && typeof v === 'object' && 'name' in v && 'getCellValue' in v) {
            return String((v as { name: unknown }).name);
          }
          return (typeof v === 'string' ? v : text(v)).slice(0, 10_000);
        };
        let columns: string[] = [];
        let rows: string[][] = [];
        if (Array.isArray(data)) {
          const list = data.slice(0, s.limits.maxTableRows);
          if (list.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
            const keys: string[] = [];
            for (const r of list)
              for (const k of Object.keys(r as Json)) {
                if (!keys.includes(k) && keys.length < 100) keys.push(k);
              }
            columns = keys;
            rows = list.map((r) => keys.map((k) => cell((r as Json)[k])));
          } else {
            columns = ['Value'];
            rows = list.map((r) => (Array.isArray(r) ? r.slice(0, 100).map(cell) : [cell(r)]));
            const width = Math.max(1, ...rows.map((r) => r.length));
            if (width > 1) columns = Array.from({ length: width }, (_, i) => String(i));
          }
        } else if (data && typeof data === 'object') {
          columns = ['Key', 'Value'];
          rows = Object.entries(data as Json)
            .slice(0, s.limits.maxTableRows)
            .map(([k, v]) => [k, cell(v)]);
        } else {
          columns = ['Value'];
          rows = [[cell(data)]];
        }
        send({ type: 'output', kind: 'table', columns, rows });
      },
    });

    const labelOf = (value: unknown) => text(value ?? '').slice(0, 1_000);
    const input = Object.freeze({
      async textAsync(label: unknown) {
        return (await call('input', { kind: 'text', label: labelOf(label) })) as string;
      },
      async buttonsAsync(label: unknown, options: unknown) {
        if (!Array.isArray(options) || options.length === 0) {
          throw new Error('buttonsAsync needs a list of options.');
        }
        const list = options.slice(0, 20).map((o) =>
          o && typeof o === 'object'
            ? {
                label: text((o as Json)['label']).slice(0, 200),
                value: 'value' in (o as Json) ? (o as Json)['value'] : (o as Json)['label'],
                variant: (o as Json)['variant'],
              }
            : { label: text(o).slice(0, 200), value: o, variant: undefined }
        );
        const index = (await call('input', {
          kind: 'buttons',
          label: labelOf(label),
          options: list.map((o) => ({
            label: o.label || '(empty)',
            ...(['default', 'primary', 'secondary', 'danger'].includes(String(o.variant))
              ? { variant: o.variant }
              : {}),
          })),
        })) as number;
        return list[index]?.value;
      },
      async tableAsync(label: unknown) {
        const tableId = (await call('input', { kind: 'table', label: labelOf(label) })) as string;
        return tableObject(tableId);
      },
      async viewAsync(label: unknown, table: unknown) {
        const t = tableOf(table);
        const viewId = (await call('input', {
          kind: 'view',
          label: labelOf(label),
          tableId: t.id,
        })) as string;
        return tableObject(t.id)?.getViewIfExists(viewId) ?? null;
      },
      async fieldAsync(label: unknown, table: unknown) {
        const t = tableOf(table);
        const fieldId = (await call('input', {
          kind: 'field',
          label: labelOf(label),
          tableId: t.id,
        })) as string;
        return tableObject(t.id)?.getFieldIfExists(fieldId) ?? null;
      },
      async recordAsync(label: unknown, source: unknown) {
        let t: TableInfo | undefined;
        let viewId: string | undefined;
        let recordIds: unknown[] | undefined;
        if (Array.isArray(source)) {
          recordIds = source.map(idOf);
        } else if (source && typeof source === 'object' && 'recordIds' in source) {
          recordIds = (source as { recordIds: unknown[] }).recordIds;
        }
        if (source && typeof source === 'object' && 'selectRecordsAsync' in source) {
          const key = String((source as { id?: unknown }).id);
          t = tableById.get(key) ?? s.base.tables.find((x) => x.views.some((v) => v.id === key));
          if (t && t.id !== key) viewId = key;
        }
        if (!t && recordIds) {
          throw new Error('recordAsync needs a table or view for a list of records.');
        }
        if (!t) throw new Error('recordAsync needs a table, a view or a query result.');
        const args: Json = { kind: 'record', label: labelOf(label), tableId: t.id };
        if (viewId) args['viewId'] = viewId;
        if (recordIds) args['recordIds'] = recordIds;
        const r = (await call('input', args)) as RecordData | null;
        return r ? recordApi(t, r) : null;
      },
    });

    const log =
      (level: string) =>
      (...args: unknown[]) =>
        send({ type: 'log', level, text: clip(args.map(text).join(' ')) });
    const console = Object.freeze({
      log: log('log'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
    });
    const session = Object.freeze({
      currentUser: s.session.currentUser ? Object.freeze(s.session.currentUser) : null,
    });
    const remoteFetchAsync = () => {
      throw new Error("remoteFetchAsync isn't available in OpenRows scripts yet.");
    };

    // The script is the body of an async function; its line numbers are offset by the header.
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const names = ['base', 'input', 'output', 'session', 'console', 'remoteFetchAsync'];
    const lineOf = (err: unknown): number | null => {
      const stack = err instanceof Error ? String(err.stack ?? '') : '';
      const m = /<anonymous>:(\d+):\d+/.exec(stack);
      return m ? Math.max(1, Number(m[1]) - 2) : null;
    };
    let fn: (...args: unknown[]) => Promise<unknown>;
    try {
      fn = new AsyncFunction(...names, s.code);
    } catch (err) {
      send({
        type: 'error',
        message: text(err).slice(0, 10_000),
        line: lineOf(err),
      });
      return;
    }
    fn(base, input, output, session, console, remoteFetchAsync).then(
      () => send({ type: 'done' }),
      (err: unknown) =>
        send({ type: 'error', message: text(err).slice(0, 10_000), line: lineOf(err) })
    );
  };

  scope.onmessage = (event) => {
    if (port) return;
    const p = event.ports[0];
    if (!p) return;
    port = p;
    p.onmessage = (e) => {
      const m = e.data as {
        type?: string;
        id?: number;
        ok?: boolean;
        value?: unknown;
        error?: string;
      };
      if (m?.type !== 'result' || typeof m.id !== 'number') return;
      const waiting = pending.get(m.id);
      if (!waiting) return;
      pending.delete(m.id);
      if (m.ok) waiting.resolve(m.value);
      else {
        const err = new Error(String(m.error ?? 'The call failed.'));
        const frames = String(waiting.site.stack ?? '')
          .split('\n')
          .slice(1);
        err.stack = [`Error: ${err.message}`, ...frames].join('\n');
        waiting.reject(err);
      }
    };
    start(event.data as Start);
  };
}

// The frame's globals it uses.
interface FrameWindow {
  parent: unknown;
  addEventListener(
    type: 'message',
    listener: (event: { source: unknown; data: unknown; ports: readonly unknown[] }) => void
  ): void;
}
interface FrameGlobals {
  window: FrameWindow;
  Worker: new (url: string) => { postMessage(message: unknown, transfer: unknown[]): void };
  URL: { createObjectURL(blob: unknown): string };
  Blob: new (parts: string[], options: { type: string }) => unknown;
}

/**
 * The frame: takes the first message from its parent that carries a port, starts the worker
 * from a blob URL and hands it the message and the port. Anything else is ignored.
 */
export function sandboxFrameMain(g: FrameGlobals, workerSource: string): void {
  let started = false;
  g.window.addEventListener('message', (event) => {
    if (started || event.source !== g.window.parent) return;
    const port = event.ports[0];
    if (!port) return;
    started = true;
    const blob = new g.Blob([workerSource], { type: 'text/javascript' });
    const worker = new g.Worker(g.URL.createObjectURL(blob));
    worker.postMessage(event.data, [port]);
  });
}

/** The frame's one inline script (the server hashes it for the CSP). */
export function sandboxFrameScript(): string {
  const worker = `(${scriptWorkerMain.toString()})(self);`;
  // `<` escaped, so nothing in the source can close the document's <script> element.
  const source = JSON.stringify(worker).replace(/</g, '\\u003c');
  return `(${sandboxFrameMain.toString()})({ window, Worker, URL, Blob }, ${source});`;
}

/** The sandbox document served at SCRIPT_SANDBOX_PATH. */
export function sandboxDocument(script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OpenRows script sandbox</title></head><body><script>${script}</script></body></html>`;
}
