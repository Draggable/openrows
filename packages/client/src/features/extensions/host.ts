import {
  EXTENSION_LIMITS,
  EXTENSION_METHOD_SCOPES,
  type ExtensionBundle,
  type ExtensionCallArgs,
  type ExtensionCallMethod,
  type ExtensionCursor,
  type ExtensionEvent,
  type ExtensionInit,
  type ExtensionRecordData,
  type ExtensionScope,
  type ExtensionSettings,
  type ExtensionStart,
  extensionCallArgsSchemas,
  extensionMessageSchema,
  extensionSandboxPath,
  QUERY_PAGE_MAX,
  type QueryRecordsResult,
  type RecordData,
} from '@openrows/shared';
import { ApiError } from '../../api/client';
import { cellText } from '../grid/cells/model';
import { type HostTable, type ScriptApi, ScriptCallError, scriptBase } from '../scripts/host';

/**
 * The app's side of an extension. The extension runs in a sandboxed frame (shared's
 * extensions/runtime.ts) and reaches the base only through this host: every message is parsed,
 * a call needs the scope EXTENSION_METHOD_SCOPES names and the manifest declares, tables, views
 * and fields must be the base's, calls are rate-limited, and they go to the normal API as the
 * signed-in person (the scripts' `ScriptApi`), so roles, edit permissions and quotas hold.
 */

export interface ExtensionHostDeps {
  api: ScriptApi;
  /** Saves the installation's settings (the settings route: editors and up). */
  saveSettings: (settings: ExtensionSettings) => Promise<ExtensionSettings>;
  /** Opens a link in a new tab. */
  openUrl: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A refusal the extension sees as a rejected promise. */
export class ExtensionCallError extends ScriptCallError {
  override name = 'ExtensionCallError';
}

export function callErrorMessage(err: unknown): string {
  if (err instanceof ScriptCallError) return err.message;
  if (err instanceof ApiError) {
    return (err.message || `The request failed (${err.status}).`).slice(0, 1_000);
  }
  return 'The request failed.';
}

/** The base as an extension sees it: no tables without `records:read`. */
export function extensionBase(
  base: { id: string; name: string },
  tables: HostTable[],
  scopes: readonly ExtensionScope[]
): ExtensionInit['base'] {
  return scriptBase(base, scopes.includes('records:read') ? tables : []);
}

export function toExtensionRecord(
  t: HostTable,
  r: RecordData | QueryRecordsResult['records'][number]
): ExtensionRecordData {
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
  };
}

const SCOPE_REFUSALS: Record<ExtensionScope, string> = {
  'records:read':
    "This extension may not read records (its manifest doesn't ask for records:read).",
  'records:write':
    "This extension may not change records (its manifest doesn't ask for records:write).",
  'cursor:read': 'This extension may not see your selection (no cursor:read).',
  'settings:write': 'This extension may not change its settings (no settings:write).',
  'embed:frames': 'This extension may not embed content (no embed:frames).',
};

/**
 * Handles one installation's calls. `getTables` answers the base's current tables;
 * `watch`/`unwatch` keep the set of watched tables, which the panel reads to push `records`
 * events.
 */
export function createExtensionCallHandler(opts: {
  scopes: readonly ExtensionScope[];
  canEditSettings: boolean;
  getTables: () => HostTable[];
  deps: ExtensionHostDeps;
}) {
  const { deps } = opts;
  const scopes = new Set(opts.scopes);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const watched = new Set<string>();
  let tokens: number = EXTENSION_LIMITS.callsPerSecond;
  let last = now();

  const fail = (message: string): never => {
    throw new ExtensionCallError(message);
  };
  const tableOf = (tableId: string) =>
    opts.getTables().find((t) => t.id === tableId) ?? fail('No such table in this base.');
  const fieldOf = (t: HostTable, fieldId: string) =>
    t.fields.find((f) => f.id === fieldId) ?? fail(`No such field in ${t.name}.`);
  const viewOf = (t: HostTable, viewId: string) =>
    t.views.find((v) => v.id === viewId) ?? fail(`No such view in ${t.name}.`);
  const throttle = async () => {
    const t = now();
    const rate = EXTENSION_LIMITS.callsPerSecond;
    tokens = Math.min(rate, tokens + ((t - last) / 1000) * rate);
    last = t;
    if (tokens < 1) {
      await sleep(Math.ceil(((1 - tokens) / rate) * 1000));
      tokens = 1;
      last = now();
    }
    tokens -= 1;
  };
  const checkCells = (t: HostTable, records: { fields: Record<string, unknown> }[]) => {
    for (const r of records) for (const id of Object.keys(r.fields)) fieldOf(t, id);
  };

  const handlers: {
    [M in ExtensionCallMethod]: (args: ExtensionCallArgs[M]) => Promise<unknown>;
  } = {
    select: async (a) => {
      const t = tableOf(a.tableId);
      if (a.viewId) viewOf(t, a.viewId);
      for (const id of a.fieldIds ?? []) fieldOf(t, id);
      for (const s of a.sorts ?? []) fieldOf(t, s.fieldId);
      const primary = t.fields.find((f) => f.isPrimary)?.id;
      const fields = a.fieldIds
        ? [...new Set([...(primary ? [primary] : []), ...a.fieldIds])]
        : t.fields.map((f) => f.id);
      const limit = a.limit ?? EXTENSION_LIMITS.maxSelect;
      const wanted = a.recordIds ? new Set(a.recordIds) : null;
      const out: ExtensionRecordData[] = [];
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
        for (const r of page.records) {
          if (out.length >= limit) break;
          if (!wanted || wanted.has(r.id)) out.push(toExtensionRecord(t, r));
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor && out.length < limit);
      return { records: out };
    },
    get: async (a) => {
      const t = tableOf(a.tableId);
      await throttle();
      try {
        return toExtensionRecord(t, await deps.api.get(t.id, a.recordId));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    create: async (a) => {
      const t = tableOf(a.tableId);
      checkCells(t, a.records);
      await throttle();
      return { ids: (await deps.api.create(t.id, a.records)).map((r) => r.id) };
    },
    update: async (a) => {
      const t = tableOf(a.tableId);
      checkCells(t, a.records);
      await throttle();
      return { ids: (await deps.api.update(t.id, a.records)).map((r) => r.id) };
    },
    delete: async (a) => {
      const t = tableOf(a.tableId);
      const ids = [...new Set(a.recordIds)];
      await throttle();
      await deps.api.delete(t.id, ids);
      return { ids };
    },
    watch: async (a) => {
      watched.add(tableOf(a.tableId).id);
      return null;
    },
    unwatch: async (a) => {
      watched.delete(a.tableId);
      return null;
    },
    setSettings: async (a) => {
      if (!opts.canEditSettings) fail('Only editors and up change extension settings.');
      await throttle();
      await deps.saveSettings(a.settings);
      return null;
    },
    openUrl: async (a) => {
      deps.openUrl(a.url);
      return null;
    },
  };

  const handle = async (method: ExtensionCallMethod, raw: unknown): Promise<unknown> => {
    const scope = EXTENSION_METHOD_SCOPES[method];
    if (scope && !scopes.has(scope)) fail(SCOPE_REFUSALS[scope]);
    const parsed = extensionCallArgsSchemas[method].safeParse(raw);
    if (!parsed.success) fail(`Invalid ${method} call.`);
    return (handlers[method] as (args: unknown) => Promise<unknown>)(parsed.data);
  };
  return { handle, watched };
}

export interface MountedExtension {
  /** Pushes an event (dropped when the scope doesn't allow it). */
  push(event: ExtensionEvent): void;
  /** Tells the extension `tableIds` changed (null: every watched table). */
  changed(tableIds: readonly string[] | null): void;
  destroy(): void;
}

/**
 * Frames an installation: SANDBOX (+ `?embed=1` with `embed:frames`) sandboxed with
 * `allow-scripts allow-modals` only (an opaque origin), given the bundle, the init and one end
 * of a MessageChannel once loaded. A second load means the extension navigated its frame away:
 * it's stopped.
 */
export function mountExtension(opts: {
  frame: HTMLIFrameElement;
  bundle: ExtensionBundle;
  init: ExtensionInit;
  getTables: () => HostTable[];
  deps: ExtensionHostDeps;
  onError: (message: string) => void;
}): MountedExtension {
  const { frame, init } = opts;
  const { handle, watched } = createExtensionCallHandler({
    scopes: init.scopes,
    canEditSettings: init.canEditSettings,
    getTables: opts.getTables,
    deps: opts.deps,
  });
  const channel = new MessageChannel();
  let ended = false;
  let loads = 0;

  const post = (message: unknown) => {
    if (!ended) channel.port1.postMessage(message);
  };
  channel.port1.onmessage = (event: MessageEvent) => {
    const parsed = extensionMessageSchema.safeParse(event.data);
    if (!parsed.success) {
      opts.onError('The extension sent something unexpected and was stopped.');
      stop();
      return;
    }
    const m = parsed.data;
    if (m.type === 'error') {
      opts.onError(m.message);
      return;
    }
    handle(m.method, m.args).then(
      (value) => post({ type: 'result', id: m.id, ok: true, value }),
      (err: unknown) => post({ type: 'result', id: m.id, ok: false, error: callErrorMessage(err) })
    );
  };

  const onLoad = () => {
    loads += 1;
    if (loads > 1) {
      opts.onError('The extension left its frame and was stopped.');
      stop();
      return;
    }
    const start: ExtensionStart = { type: 'start', bundle: opts.bundle, init };
    // The frame's origin is opaque, so '*' is the only target there is; it takes the first
    // message with a port and ignores the rest.
    frame.contentWindow?.postMessage(start, '*', [channel.port2]);
  };
  frame.addEventListener('load', onLoad);
  frame.setAttribute('sandbox', 'allow-scripts allow-modals');
  frame.src = extensionSandboxPath(init.scopes);

  /** Ends the channel (the panel removes the frame). */
  const destroy = () => {
    if (ended) return;
    ended = true;
    frame.removeEventListener('load', onLoad);
    channel.port1.close();
  };
  /** Ends it and empties the frame: the extension misbehaved. */
  const stop = () => {
    destroy();
    frame.src = 'about:blank';
  };

  return {
    push(event) {
      if (event.name === 'cursor' && !init.scopes.includes('cursor:read')) return;
      if (event.name === 'records' && !watched.has(event.tableId)) return;
      post(event);
    },
    changed(tableIds) {
      for (const tableId of tableIds ?? [...watched]) {
        if (watched.has(tableId)) post({ type: 'event', name: 'records', tableId });
      }
    },
    destroy,
  };
}

/** The cursor from the page's state. */
export function cursorOf(opts: {
  tableId: string | null;
  viewId: string | null;
  selectedRecordId: string | null;
  selectedFieldId: string | null;
  expandedRecordId: string | null;
}): ExtensionCursor {
  return {
    tableId: opts.tableId,
    viewId: opts.viewId,
    recordId: opts.expandedRecordId ?? opts.selectedRecordId,
    fieldId: opts.expandedRecordId ? null : opts.selectedFieldId,
  };
}
