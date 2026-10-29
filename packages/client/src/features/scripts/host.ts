import {
  type FieldMeta,
  getFieldType,
  QUERY_PAGE_MAX,
  type QueryRecordsInput,
  type QueryRecordsResult,
  type RecordData,
  type SandboxMessage,
  SCRIPT_RUN_LIMITS,
  SCRIPT_SANDBOX_PATH,
  type ScriptCallArgs,
  type ScriptCallMethod,
  type ScriptRecordData,
  type ScriptStart,
  type ScriptTableInfo,
  sandboxMessageSchema,
  scriptCallArgsSchemas,
} from '@openrows/shared';
import { ApiError } from '../../api/client';
import { cellText } from '../grid/cells/model';

/**
 * The app's side of a browser script. The script runs in a sandboxed frame's worker
 * (shared's scripts/sandbox.ts) and reaches the base only through `ScriptHost`: every message
 * from it is parsed, its tables, views and fields must be this base's, the per-run limits hold,
 * and the calls go to the normal API as the signed-in person (`ScriptApi`), so the server's
 * authorization, edit permissions, quotas and rate limits apply as for any edit in the app.
 */

/** The API calls a run makes (the page passes the typed client's). */
export interface ScriptApi {
  query(tableId: string, body: QueryRecordsInput): Promise<QueryRecordsResult>;
  get(tableId: string, recordId: string): Promise<RecordData>;
  create(tableId: string, records: { fields: Record<string, unknown> }[]): Promise<RecordData[]>;
  update(
    tableId: string,
    records: { id: string; fields: Record<string, unknown> }[]
  ): Promise<RecordData[]>;
  delete(tableId: string, recordIds: string[]): Promise<void>;
}

/** What the script asked the person running it for. */
export type ScriptPrompt =
  | { kind: 'text'; label: string }
  | {
      kind: 'buttons';
      label: string;
      options: { label: string; variant?: 'default' | 'primary' | 'secondary' | 'danger' }[];
    }
  | { kind: 'table'; label: string }
  | { kind: 'view'; label: string; tableId: string }
  | { kind: 'field'; label: string; tableId: string }
  | { kind: 'record'; label: string; tableId: string; records: { id: string; name: string }[] };

/** Answers per prompt kind: text, a button's index, an id, a record id or null. */
export type PromptAnswer = string | number | null;

/** One entry of the run's output panel. */
export type OutputEntry =
  | { kind: 'text' | 'markdown' | 'inspect'; text: string }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'log'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'clear' };

/** A base's tables with their fields as the API returns them, and their views. */
export interface HostTable {
  id: string;
  name: string;
  description: string | null;
  fields: FieldMeta[];
  views: { id: string; name: string; type: string }[];
}

export interface ScriptHostDeps {
  api: ScriptApi;
  prompt: (prompt: ScriptPrompt) => Promise<PromptAnswer>;
  output: (entry: OutputEntry) => void;
  /** Waits (the rate limit); tests pass a fake clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class ScriptCallError extends Error {
  override name = 'ScriptCallError';
}

/** The base as the script sees it (shared's ScriptTableInfo). */
export function scriptBase(base: { id: string; name: string }, tables: HostTable[]) {
  return {
    id: base.id,
    name: base.name,
    tables: tables.map(
      (t): ScriptTableInfo => ({
        id: t.id,
        name: t.name,
        description: t.description,
        primaryFieldId: t.fields.find((f) => f.isPrimary)?.id ?? null,
        fields: t.fields.map((f) => ({
          id: f.id,
          name: f.name,
          type: f.type,
          description: f.description ?? null,
          options: f.options ?? null,
          isComputed: getFieldType(f.type).readOnly,
        })),
        views: t.views.map((v) => ({ id: v.id, name: v.name, type: v.type })),
      })
    ),
  };
}

/** A message for the script from a refused API call (the problem's detail when there is one). */
export function callErrorMessage(err: unknown): string {
  if (err instanceof ScriptCallError) return err.message;
  if (err instanceof ApiError) {
    return (err.message || `The request failed (${err.status}).`).slice(0, 1_000);
  }
  return 'The request failed.';
}

/**
 * Handles one run's calls. Answers with the value for the script, or throws (ScriptCallError or
 * the API's error) for a refusal the script sees as a rejected promise.
 */
export function createCallHandler(tables: HostTable[], deps: ScriptHostDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const limits = SCRIPT_RUN_LIMITS;
  let calls = 0;
  let read = 0;
  let written = 0;
  // A token bucket: `callsPerSecond` a second, bursts up to the same.
  let tokens: number = limits.callsPerSecond;
  let last = now();

  const fail = (message: string): never => {
    throw new ScriptCallError(message);
  };
  const tableOf = (tableId: string) =>
    tables.find((t) => t.id === tableId) ?? fail('No such table in this base.');
  const fieldOf = (t: HostTable, fieldId: string) =>
    t.fields.find((f) => f.id === fieldId) ?? fail(`No such field in ${t.name}.`);
  const viewOf = (t: HostTable, viewId: string) =>
    t.views.find((v) => v.id === viewId) ?? fail(`No such view in ${t.name}.`);

  const throttle = async () => {
    calls += 1;
    if (calls > limits.maxCalls) fail(`A run makes at most ${limits.maxCalls} calls.`);
    const t = now();
    tokens = Math.min(limits.callsPerSecond, tokens + ((t - last) / 1000) * limits.callsPerSecond);
    last = t;
    if (tokens < 1) {
      await sleep(Math.ceil(((1 - tokens) / limits.callsPerSecond) * 1000));
      tokens = 1;
      last = now();
    }
    tokens -= 1;
  };
  const countRead = (n: number) => {
    read += n;
    if (read > limits.maxRecordsRead) {
      fail(`A run reads at most ${limits.maxRecordsRead.toLocaleString('en')} records.`);
    }
  };
  const countWrite = (n: number) => {
    if (written + n > limits.maxRecordsWritten) {
      fail(`A run changes at most ${limits.maxRecordsWritten.toLocaleString('en')} records.`);
    }
    written += n;
  };

  const toRecord = (t: HostTable, r: RecordData | QueryRecordsResult['records'][number]) => {
    const strings: Record<string, string> = {};
    for (const f of t.fields) {
      if (f.id in r.fields) strings[f.id] = cellText(f, r.fields[f.id]);
    }
    const primary = t.fields.find((f) => f.isPrimary);
    return {
      id: r.id,
      name: (primary && strings[primary.id]) || 'Unnamed record',
      createdTime: r.createdAt,
      cells: r.fields,
      strings,
    } satisfies ScriptRecordData;
  };
  const checkCells = (t: HostTable, records: { fields: Record<string, unknown> }[]) => {
    for (const r of records) for (const id of Object.keys(r.fields)) fieldOf(t, id);
  };

  /** Every record of the table (or view) matching the options, paged by cursor. */
  const selectAll = async (a: ScriptCallArgs['select']) => {
    const t = tableOf(a.tableId);
    if (a.viewId) viewOf(t, a.viewId);
    for (const id of a.fieldIds ?? []) fieldOf(t, id);
    for (const s of a.sorts ?? []) fieldOf(t, s.fieldId);
    const primary = t.fields.find((f) => f.isPrimary)?.id;
    const fields = a.fieldIds
      ? [...new Set([...(primary ? [primary] : []), ...a.fieldIds])]
      : // Every field: a view's own hidden fields too, as Airtable's scripts read them.
        t.fields.map((f) => f.id);
    const wanted = a.recordIds ? new Set(a.recordIds) : null;
    const out: ScriptRecordData[] = [];
    let cursor: string | undefined;
    do {
      await throttle();
      const page = await deps.api.query(t.id, {
        ...(a.viewId ? { viewId: a.viewId } : {}),
        query: { fields, ...(a.sorts ? { sorts: a.sorts } : {}) },
        limit: QUERY_PAGE_MAX,
        count: false,
        groups: false,
        ...(cursor ? { cursor } : {}),
      });
      countRead(page.records.length);
      for (const r of page.records) if (!wanted || wanted.has(r.id)) out.push(toRecord(t, r));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return out;
  };

  const handlers: {
    [M in ScriptCallMethod]: (args: ScriptCallArgs[M]) => Promise<unknown>;
  } = {
    select: async (a) => ({ records: await selectAll(a) }),
    get: async (a) => {
      const t = tableOf(a.tableId);
      await throttle();
      try {
        const r = await deps.api.get(t.id, a.recordId);
        countRead(1);
        return toRecord(t, r);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    create: async (a) => {
      const t = tableOf(a.tableId);
      checkCells(t, a.records);
      countWrite(a.records.length);
      await throttle();
      const created = await deps.api.create(t.id, a.records);
      return { ids: created.map((r) => r.id) };
    },
    update: async (a) => {
      const t = tableOf(a.tableId);
      checkCells(t, a.records);
      countWrite(a.records.length);
      await throttle();
      const updated = await deps.api.update(t.id, a.records);
      return { ids: updated.map((r) => r.id) };
    },
    delete: async (a) => {
      const t = tableOf(a.tableId);
      const ids = [...new Set(a.recordIds)];
      countWrite(ids.length);
      await throttle();
      await deps.api.delete(t.id, ids);
      return { ids };
    },
    input: async (a) => {
      switch (a.kind) {
        case 'text':
          return String((await deps.prompt(a)) ?? '');
        case 'buttons': {
          const index = await deps.prompt(a);
          return typeof index === 'number' && index >= 0 && index < a.options.length ? index : 0;
        }
        case 'table': {
          const id = await deps.prompt(a);
          return tableOf(String(id)).id;
        }
        case 'view': {
          const t = tableOf(a.tableId);
          return viewOf(t, String(await deps.prompt(a))).id;
        }
        case 'field': {
          const t = tableOf(a.tableId);
          return fieldOf(t, String(await deps.prompt(a))).id;
        }
        case 'record': {
          const t = tableOf(a.tableId);
          const records = await selectAll({
            tableId: t.id,
            ...(a.viewId ? { viewId: a.viewId } : {}),
            ...(a.recordIds ? { recordIds: a.recordIds } : {}),
          });
          const chosen = await deps.prompt({
            kind: 'record',
            label: a.label,
            tableId: t.id,
            records: records.map((r) => ({ id: r.id, name: r.name })),
          });
          return records.find((r) => r.id === chosen) ?? null;
        }
      }
    },
  };

  return async (method: ScriptCallMethod, raw: unknown): Promise<unknown> => {
    const parsed = scriptCallArgsSchemas[method].safeParse(raw);
    if (!parsed.success) fail(`Invalid ${method} call.`);
    return (handlers[method] as (args: unknown) => Promise<unknown>)(parsed.data);
  };
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface ScriptRun {
  stop(): void;
  /** Resolves when the run ends, however it ends. */
  done: Promise<RunStatus>;
}

/**
 * Starts a run: a hidden sandboxed frame of SCRIPT_SANDBOX_PATH (`sandbox="allow-scripts"`
 * only: an opaque origin), given the code and one end of a MessageChannel once loaded. Stop and
 * the time limit remove the frame, which ends its worker.
 */
export function startScript(opts: {
  code: string;
  base: ScriptStart['base'];
  tables: HostTable[];
  session: ScriptStart['session'];
  container: HTMLElement;
  deps: ScriptHostDeps;
}): ScriptRun {
  const handle = createCallHandler(opts.tables, opts.deps);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', 'Script sandbox');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.display = 'none';
  frame.src = SCRIPT_SANDBOX_PATH;

  let finish: (status: RunStatus) => void = () => {};
  const done = new Promise<RunStatus>((resolve) => {
    finish = resolve;
  });
  let ended = false;
  let entries = 0;
  const channel = new MessageChannel();
  const end = (status: RunStatus) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    channel.port1.close();
    frame.remove();
    finish(status);
  };
  const output = (entry: OutputEntry) => {
    entries += 1;
    if (entries === SCRIPT_RUN_LIMITS.maxOutputEntries + 1) {
      opts.deps.output({
        kind: 'log',
        level: 'warn',
        text: `Only the first ${SCRIPT_RUN_LIMITS.maxOutputEntries} outputs are shown.`,
      });
    }
    if (entries <= SCRIPT_RUN_LIMITS.maxOutputEntries) opts.deps.output(entry);
  };
  const timer = setTimeout(() => {
    opts.deps.output({
      kind: 'error',
      text: `The script ran longer than ${SCRIPT_RUN_LIMITS.timeoutMs / 60_000} minutes and was stopped.`,
    });
    end('failed');
  }, SCRIPT_RUN_LIMITS.timeoutMs);

  const onMessage = async (message: SandboxMessage) => {
    switch (message.type) {
      case 'call': {
        try {
          const value = await handle(message.method, message.args);
          if (!ended)
            channel.port1.postMessage({ type: 'result', id: message.id, ok: true, value });
        } catch (err) {
          if (!ended) {
            channel.port1.postMessage({
              type: 'result',
              id: message.id,
              ok: false,
              error: callErrorMessage(err),
            });
          }
        }
        return;
      }
      case 'output':
        if (message.kind === 'clear') {
          entries = 0;
          opts.deps.output({ kind: 'clear' });
          return;
        }
        if (message.kind === 'table') {
          output({ kind: 'table', columns: message.columns, rows: message.rows });
          return;
        }
        output({ kind: message.kind, text: message.text });
        return;
      case 'log':
        output({ kind: 'log', level: message.level, text: message.text });
        return;
      case 'done':
        end('succeeded');
        return;
      case 'error':
        opts.deps.output({
          kind: 'error',
          text: message.line ? `${message.message} (line ${message.line})` : message.message,
        });
        end('failed');
        return;
    }
  };
  channel.port1.onmessage = (event: MessageEvent) => {
    const parsed = sandboxMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      opts.deps.output({
        kind: 'error',
        text: 'The script sent something unexpected and was stopped.',
      });
      end('failed');
      return;
    }
    void onMessage(parsed.data);
  };

  frame.addEventListener(
    'load',
    () => {
      const start: ScriptStart = {
        type: 'start',
        code: opts.code,
        base: opts.base,
        session: opts.session,
        limits: SCRIPT_RUN_LIMITS,
      };
      // The frame's origin is opaque, so '*' is the only target there is; the frame takes the
      // first message with a port and ignores the rest.
      frame.contentWindow?.postMessage(start, '*', [channel.port2]);
    },
    { once: true }
  );
  opts.container.appendChild(frame);
  return { stop: () => end('stopped'), done };
}
