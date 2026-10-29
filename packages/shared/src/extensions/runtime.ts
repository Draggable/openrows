/**
 * Extensions: what runs inside the extension's frame. `extensionFrameMain` is serialized
 * with Function.prototype.toString into the sandbox document (`extensionFrameScript`), so it
 * must be self-contained: no imports, no closures over this module, nothing tsc would add a
 * helper for. protocol.ts describes the messages; `@openrows/blocks` types `window.openrows`.
 */

// The frame's globals it uses (shared builds without the DOM library).
interface FramePort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}
interface FrameElement {
  textContent: string | null;
  innerHTML: string;
  appendChild(child: unknown): unknown;
  setAttribute(name: string, value: string): void;
}
export interface ExtensionFrameGlobals {
  window: {
    parent: unknown;
    addEventListener(
      type: 'message',
      listener: (event: { source: unknown; data: unknown; ports: readonly unknown[] }) => void
    ): void;
    addEventListener(
      type: 'error',
      listener: (event: { message?: unknown; error?: unknown }) => void
    ): void;
    addEventListener(
      type: 'unhandledrejection',
      listener: (event: { reason?: unknown }) => void
    ): void;
    openrows?: unknown;
  };
  document: {
    head: FrameElement;
    body: FrameElement;
    documentElement: FrameElement;
    createElement(tag: string): FrameElement;
  };
  Function: new (...args: string[]) => () => unknown;
}

/**
 * The frame: takes the first message from its parent that carries a port, puts the bundle's
 * CSS and HTML in the document, sets `window.openrows` and runs the bundle's JS.
 */
export function extensionFrameMain(g: ExtensionFrameGlobals): void {
  type Json = Record<string, unknown>;
  type Field = { id: string; name: string; type: string; options: unknown; isComputed: boolean };
  type Table = {
    id: string;
    name: string;
    primaryFieldId: string | null;
    fields: Field[];
    views: { id: string; name: string; type: string }[];
  };
  type Init = {
    installation: { id: string; name: string };
    scopes: string[];
    theme: string;
    base: { id: string; name: string; tables: Table[] };
    cursor: Json | null;
    settings: Json;
    canEditSettings: boolean;
    limits: { maxWriteBatch: number };
  };
  type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

  let started = false;
  g.window.addEventListener('message', (event) => {
    if (started || event.source !== g.window.parent) return;
    const port = event.ports[0] as FramePort | undefined;
    const data = event.data as { type?: unknown; bundle?: Json; init?: Init } | null;
    if (!port || data?.type !== 'start' || !data.bundle || !data.init) return;
    started = true;
    const init = data.init;
    const bundle = data.bundle;

    const pending = new Map<number, Pending>();
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const watchers = new Map<string, Set<() => void>>();
    let seq = 0;
    const send = (message: Json) => port.postMessage(message);
    const call = (method: string, args: Json): Promise<unknown> =>
      new Promise((resolve, reject) => {
        seq += 1;
        pending.set(seq, { resolve, reject });
        send({ type: 'call', id: seq, method, args });
      });
    const text = (v: unknown) => (typeof v === 'string' ? v : String(v)).slice(0, 2_000);
    const report = (err: unknown) => {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : text(err);
      send({ type: 'error', message: text(message) });
    };
    const copy = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
    const emit = (name: string, value: unknown) => {
      for (const cb of listeners.get(name) ?? []) {
        try {
          cb(value);
        } catch (err) {
          report(err);
        }
      }
    };

    const state = {
      base: init.base,
      cursor: init.cursor,
      settings: init.settings,
      theme: init.theme,
    };
    const findIn = <T extends { id: string; name: string }>(list: T[], key: unknown) => {
      if (key && typeof key === 'object' && 'id' in key) {
        return list.find((x) => x.id === (key as { id: unknown }).id) ?? null;
      }
      if (typeof key !== 'string') return null;
      return list.find((x) => x.id === key) ?? list.find((x) => x.name === key) ?? null;
    };
    const tableOf = (key: unknown): Table => {
      const t = findIn(state.base.tables, key);
      if (!t) throw new Error(`No table "${text(key).slice(0, 100)}" in this base.`);
      return t;
    };
    const fieldOf = (t: Table, key: unknown): Field => {
      const f = findIn(t.fields, key);
      if (!f) throw new Error(`No field "${text(key).slice(0, 100)}" in ${t.name}.`);
      return f;
    };
    const cellsById = (t: Table, fields: unknown): Json => {
      if (!fields || typeof fields !== 'object') throw new Error('Pass the cells as an object.');
      const out: Json = {};
      for (const [k, v] of Object.entries(fields as Json)) {
        out[fieldOf(t, k).id] = v === undefined ? null : copy(v);
      }
      return out;
    };
    const batch = (list: unknown): unknown[] => {
      if (!Array.isArray(list)) throw new Error('Pass an array of records.');
      if (list.length > init.limits.maxWriteBatch) {
        throw new Error(`At most ${init.limits.maxWriteBatch} records per call.`);
      }
      return list;
    };
    const idOf = (r: unknown): unknown =>
      r && typeof r === 'object' && 'id' in r ? (r as { id: unknown }).id : r;
    const has = (scope: string) => init.scopes.includes(scope);
    // The host refuses these anyway; refusing here first gives a clearer error than "No table".
    const need = (scope: string) => {
      if (!has(scope)) throw new Error(`This extension's manifest doesn't ask for ${scope}.`);
    };

    const api = Object.freeze({
      installation: Object.freeze({ ...init.installation }),
      scopes: Object.freeze([...init.scopes]),
      hasScope: has,
      get theme() {
        return state.theme;
      },
      get base() {
        return copy(state.base);
      },
      get cursor() {
        return copy(state.cursor);
      },
      get settings() {
        return copy(state.settings);
      },
      get canEditSettings() {
        return init.canEditSettings;
      },
      getTable(key: unknown) {
        return copy(tableOf(key));
      },
      getTableIfExists(key: unknown) {
        return copy(findIn(state.base.tables, key));
      },
      /** `cursor`, `settings`, `theme` or `base`; answers the unsubscribe. */
      on(name: string, cb: (value: unknown) => void) {
        if (typeof cb !== 'function') throw new Error('Pass a callback.');
        let set = listeners.get(name);
        if (!set) {
          set = new Set();
          listeners.set(name, set);
        }
        set.add(cb);
        return () => {
          set.delete(cb);
        };
      },
      async selectRecords(table: unknown, options: Json = {}) {
        need('records:read');
        const t = tableOf(table);
        const args: Json = { tableId: t.id };
        if (options['view'] !== undefined) {
          const v = findIn(t.views, options['view']);
          if (!v) throw new Error(`No view "${text(options['view']).slice(0, 100)}" in ${t.name}.`);
          args['viewId'] = v.id;
        }
        if (Array.isArray(options['fields'])) {
          args['fieldIds'] = options['fields'].map((f) => fieldOf(t, f).id);
        }
        if (Array.isArray(options['sorts'])) {
          args['sorts'] = options['sorts'].map((s) => ({
            fieldId: fieldOf(t, (s as Json)?.['field']).id,
            direction: (s as Json)?.['direction'] === 'desc' ? 'desc' : 'asc',
          }));
        }
        if (Array.isArray(options['recordIds'])) args['recordIds'] = options['recordIds'].map(idOf);
        if (typeof options['limit'] === 'number') args['limit'] = options['limit'];
        const res = (await call('select', args)) as { records: unknown[] };
        return res.records;
      },
      async getRecord(table: unknown, recordId: unknown) {
        need('records:read');
        const t = tableOf(table);
        return call('get', { tableId: t.id, recordId: idOf(recordId) });
      },
      async createRecords(table: unknown, records: unknown) {
        need('records:write');
        const t = tableOf(table);
        const list = batch(records).map((r) => ({
          fields: cellsById(t, (r as Json)?.['fields'] ?? r),
        }));
        if (list.length === 0) return [];
        return ((await call('create', { tableId: t.id, records: list })) as { ids: string[] }).ids;
      },
      async updateRecords(table: unknown, records: unknown) {
        need('records:write');
        const t = tableOf(table);
        const list = batch(records).map((r) => ({
          id: (r as Json)?.['id'],
          fields: cellsById(t, (r as Json)?.['fields']),
        }));
        if (list.length === 0) return;
        await call('update', { tableId: t.id, records: list });
      },
      async deleteRecords(table: unknown, recordIds: unknown) {
        need('records:write');
        const t = tableOf(table);
        const ids = batch(recordIds).map(idOf);
        if (ids.length === 0) return;
        await call('delete', { tableId: t.id, recordIds: ids });
      },
      /** Calls `cb` after records of the table change; answers the unsubscribe. */
      watchRecords(table: unknown, cb: () => void) {
        if (typeof cb !== 'function') throw new Error('Pass a callback.');
        need('records:read');
        const t = tableOf(table);
        let set = watchers.get(t.id);
        if (!set) {
          set = new Set();
          watchers.set(t.id, set);
          call('watch', { tableId: t.id }).catch(report);
        }
        set.add(cb);
        return () => {
          set.delete(cb);
          if (set.size === 0 && watchers.get(t.id) === set) {
            watchers.delete(t.id);
            call('unwatch', { tableId: t.id }).catch(() => {});
          }
        };
      },
      async setSettings(settings: unknown) {
        need('settings:write');
        await call('setSettings', { settings: copy(settings) });
      },
      async openUrl(url: unknown) {
        await call('openUrl', { url: text(url) });
      },
    });

    port.onmessage = (e) => {
      const m = e.data as Json | null;
      if (m?.['type'] === 'result' && typeof m['id'] === 'number') {
        const waiting = pending.get(m['id']);
        if (!waiting) return;
        pending.delete(m['id']);
        if (m['ok']) waiting.resolve(m['value']);
        else waiting.reject(new Error(text(m['error'] ?? 'The call failed.')));
        return;
      }
      if (m?.['type'] !== 'event') return;
      switch (m['name']) {
        case 'cursor':
          state.cursor = m['cursor'] as Json;
          emit('cursor', copy(state.cursor));
          return;
        case 'settings':
          state.settings = m['settings'] as Json;
          emit('settings', copy(state.settings));
          return;
        case 'theme':
          state.theme = String(m['theme']);
          g.document.documentElement.setAttribute('data-theme', state.theme);
          emit('theme', state.theme);
          return;
        case 'base':
          state.base = m['base'] as Init['base'];
          emit('base', copy(state.base));
          return;
        case 'records':
          for (const cb of watchers.get(String(m['tableId'])) ?? []) {
            try {
              cb();
            } catch (err) {
              report(err);
            }
          }
          return;
      }
    };

    g.window.addEventListener('error', (ev) => report(ev.error ?? ev.message));
    g.window.addEventListener('unhandledrejection', (ev) => report(ev.reason));
    g.document.documentElement.setAttribute('data-theme', state.theme);
    g.window.openrows = api;
    const style = g.document.createElement('style');
    style.textContent = String(bundle['css'] ?? '');
    g.document.head.appendChild(style);
    // Scripts in the HTML never run (innerHTML, and the CSP allows only the bootstrap).
    g.document.body.innerHTML = String(bundle['html'] ?? '');
    try {
      new g.Function(String(bundle['js'] ?? ''))();
    } catch (err) {
      report(err);
    }
  });
}

/** The frame's one inline script (the server hashes it for the CSP). */
export function extensionFrameScript(): string {
  return `(${extensionFrameMain.toString()})({ window, document, Function });`;
}

/**
 * The base stylesheet every extension gets (Ledger's tokens as CSS variables, light and dark
 * by `data-theme`), so a bundle looks like the app without shipping a design system.
 */
export const EXTENSION_BASE_CSS = `
:root{--or-bg:#faf7f5;--or-surface:#ffffff;--or-text:#1c1719;--or-text-2:#6e6468;--or-border:#e8e2dd;--or-accent:#e22651;--or-accent-text:#ffffff;--or-danger:#bd3d00;color-scheme:light}
:root[data-theme=dark]{--or-bg:#17131a;--or-surface:#211b24;--or-text:#eee8ea;--or-text-2:#a89ea5;--or-border:#362e39;--or-accent:#e22651;--or-accent-text:#ffffff;--or-danger:#f6946d;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--or-bg);color:var(--or-text);font:13px/1.45 Inter,ui-sans-serif,system-ui,sans-serif;accent-color:var(--or-accent)}
body{padding:12px}
button,select,input{font:inherit;color:inherit}
button{background:var(--or-surface);border:1px solid var(--or-border);border-radius:6px;padding:4px 10px;cursor:pointer}
button.primary{background:var(--or-accent);color:var(--or-accent-text);border-color:var(--or-accent)}
select,input{background:var(--or-surface);border:1px solid var(--or-border);border-radius:6px;padding:4px 6px}
:focus-visible{outline:2px solid var(--or-accent);outline-offset:1px}
.muted{color:var(--or-text-2)}
`.trim();

/** The sandbox document served at EXTENSION_SANDBOX_PATH. */
export function extensionSandboxDocument(script: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OpenRows extension</title><style>${EXTENSION_BASE_CSS}</style></head><body><script>${script}</script></body></html>`;
}
