import { describe, expect, it } from 'vitest';
import {
  EXTENSION_LIMITS,
  EXTENSION_SCOPES,
  extensionBundleSchema,
  extensionManifestSchema,
  extensionSandboxPath,
} from './manifest.js';
import {
  EXTENSION_METHOD_SCOPES,
  extensionCallArgsSchemas,
  extensionMessageSchema,
} from './protocol.js';
import {
  type ExtensionFrameGlobals,
  extensionFrameMain,
  extensionFrameScript,
  extensionSandboxDocument,
} from './runtime.js';
import { BUILT_IN_EXTENSIONS, builtInExtension } from './samples.js';

const T = '01900000-0000-7000-8000-000000000001';
const F = '01900000-0000-7000-8000-000000000002';
const V = '01900000-0000-7000-8000-000000000003';
const R = '01900000-0000-7000-8000-000000000004';

type Listener = (event: { source: unknown; data: unknown; ports: readonly unknown[] }) => void;

/** Fake frame globals: a window, a document that records what the bootstrap puts in it. */
function frame() {
  const parent = {};
  const listeners: Record<string, ((e: never) => void)[]> = {};
  const el = () => {
    const attrs: Record<string, string> = {};
    const children: unknown[] = [];
    return {
      textContent: null as string | null,
      innerHTML: '',
      attrs,
      children,
      appendChild(c: unknown) {
        children.push(c);
        return c;
      },
      setAttribute(n: string, v: string) {
        attrs[n] = v;
      },
    };
  };
  const g = {
    window: {
      parent,
      addEventListener(type: string, l: (e: never) => void) {
        listeners[type] ??= [];
        listeners[type].push(l);
      },
    } as ExtensionFrameGlobals['window'] & { openrows?: Record<string, unknown> },
    document: {
      head: el(),
      body: el(),
      documentElement: el(),
      createElement: () => el(),
    },
    Function,
  };
  extensionFrameMain(g as unknown as ExtensionFrameGlobals);
  const sent: Record<string, unknown>[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage(m: unknown) {
      sent.push(m as Record<string, unknown>);
    },
  };
  const post = (data: unknown, source: unknown = parent) => {
    for (const l of (listeners['message'] ?? []) as Listener[]) l({ source, data, ports: [port] });
  };
  const reply = (m: unknown) => port.onmessage?.({ data: m });
  return { g, post, sent, reply };
}

const init = (scopes: string[]) => ({
  installation: { id: R, name: 'Test' },
  scopes,
  theme: 'dark',
  base: {
    id: R,
    name: 'Base',
    tables: [
      {
        id: T,
        name: 'Tasks',
        primaryFieldId: F,
        fields: [{ id: F, name: 'Name', type: 'text', options: {}, isComputed: false }],
        views: [{ id: V, name: 'Grid', type: 'grid' }],
      },
    ],
  },
  cursor: { tableId: T, viewId: V, recordId: null, fieldId: null },
  settings: { a: 1 },
  canEditSettings: true,
  limits: EXTENSION_LIMITS,
});

const start = (scopes: string[], bundle = { html: '<p>Hi</p>', css: 'p{}', js: '' }) => {
  const f = frame();
  f.post({ type: 'start', bundle, init: init(scopes) });
  type Fn = (...a: never[]) => unknown;
  const api = f.g.window.openrows as unknown as {
    settings: unknown;
    cursor: unknown;
    theme: string;
    selectRecords: (...a: unknown[]) => Promise<unknown>;
    createRecords: (...a: unknown[]) => Promise<unknown>;
    on: (name: string, cb: Fn) => () => void;
    watchRecords: (table: string, cb: () => void) => () => void;
  };
  return { ...f, api };
};

describe('extensionFrameMain', () => {
  it('installs the bundle and window.openrows on the parent’s start message', () => {
    const { g, api } = start(['records:read']);
    expect(g.document.body.innerHTML).toBe('<p>Hi</p>');
    expect(
      (g.document.head as unknown as { children: { textContent: string }[] }).children[0]
        ?.textContent
    ).toBe('p{}');
    expect(api.theme).toBe('dark');
    expect(api.settings).toEqual({ a: 1 });
  });

  it('ignores messages from anyone but the parent, and a second start', () => {
    const f = frame();
    f.post({ type: 'start', bundle: {}, init: init([]) }, {});
    expect(f.g.window.openrows).toBeUndefined();
    f.post({ type: 'start', bundle: { html: 'one' }, init: init([]) });
    f.post({ type: 'start', bundle: { html: 'two' }, init: init([]) });
    expect(f.g.document.body.innerHTML).toBe('one');
  });

  it('shapes calls by name, resolves results and rejects refusals', async () => {
    const { api, sent, reply } = start(['records:read', 'records:write']);
    const p = api.selectRecords('Tasks', {
      fields: ['Name'],
      sorts: [{ field: 'Name', direction: 'desc' }],
      view: 'Grid',
    });
    expect(sent.at(-1)).toEqual({
      type: 'call',
      id: 1,
      method: 'select',
      args: { tableId: T, viewId: V, fieldIds: [F], sorts: [{ fieldId: F, direction: 'desc' }] },
    });
    reply({ type: 'result', id: 1, ok: true, value: { records: [{ id: R }] } });
    await expect(p).resolves.toEqual([{ id: R }]);
    const w = api.createRecords(T, [{ fields: { Name: 'x' } }]);
    expect(sent.at(-1)).toMatchObject({
      method: 'create',
      args: { records: [{ fields: { [F]: 'x' } }] },
    });
    reply({ type: 'result', id: 2, ok: false, error: 'This extension may not change records.' });
    await expect(w).rejects.toThrow('may not change records');
    await expect(api.selectRecords('Nope')).rejects.toThrow('No table "Nope"');
  });

  it('delivers events and watched tables’ changes', () => {
    const { api, sent, reply } = start(['records:read', 'cursor:read']);
    const seen: unknown[] = [];
    api.on('cursor', (c: unknown) => seen.push(c));
    let changed = 0;
    const stop = api.watchRecords(T, () => {
      changed += 1;
    }) as () => void;
    expect(sent.at(-1)).toMatchObject({ method: 'watch', args: { tableId: T } });
    reply({ type: 'event', name: 'cursor', cursor: { tableId: T, recordId: R } });
    reply({ type: 'event', name: 'records', tableId: T });
    expect(seen).toEqual([{ tableId: T, recordId: R }]);
    expect(changed).toBe(1);
    stop();
    expect(sent.at(-1)).toMatchObject({ method: 'unwatch' });
    reply({ type: 'event', name: 'records', tableId: T });
    expect(changed).toBe(1);
  });

  it('refuses calls outside its scopes before sending them', async () => {
    const { api, sent } = start(['cursor:read']);
    await expect(api.selectRecords(T)).rejects.toThrow("doesn't ask for records:read");
    await expect(api.createRecords(T, [])).rejects.toThrow("doesn't ask for records:write");
    expect(sent).toEqual([]);
  });

  it('reports a bundle that throws', () => {
    const { sent } = start([], { html: '', css: '', js: 'throw new Error("boom")' });
    expect(sent).toContainEqual({ type: 'error', message: 'Error: boom' });
  });
});

describe('the sandbox document', () => {
  it('holds the one script, with nothing that closes its element', () => {
    const script = extensionFrameScript();
    expect(script).not.toContain('</script');
    const doc = extensionSandboxDocument(script);
    expect(doc.match(/<script>/g)).toHaveLength(1);
    expect(extensionSandboxPath(['records:read'])).toBe('/sandbox/extension');
    expect(extensionSandboxPath(['embed:frames'])).toBe('/sandbox/extension?embed=1');
  });
});

describe('manifests and messages', () => {
  it('takes valid manifests and refuses unknown or repeated scopes', () => {
    expect(
      extensionManifestSchema.parse({ manifestVersion: 1, name: ' Mine ', scopes: [] })
    ).toEqual({ manifestVersion: 1, name: 'Mine', description: '', version: '1.0.0', scopes: [] });
    expect(
      extensionManifestSchema.safeParse({ manifestVersion: 1, name: 'x', scopes: ['admin'] })
        .success
    ).toBe(false);
    expect(
      extensionManifestSchema.safeParse({
        manifestVersion: 1,
        name: 'x',
        scopes: ['records:read', 'records:read'],
      }).success
    ).toBe(false);
    expect(
      extensionBundleSchema.safeParse({ js: 'x'.repeat(EXTENSION_LIMITS.maxBundleChars + 1) })
        .success
    ).toBe(false);
  });

  it('gives every call method a scope rule and an args schema', () => {
    for (const [method, scope] of Object.entries(EXTENSION_METHOD_SCOPES)) {
      expect(method in extensionCallArgsSchemas).toBe(true);
      if (scope) expect(EXTENSION_SCOPES).toContain(scope);
    }
    expect(extensionCallArgsSchemas.openUrl.safeParse({ url: 'javascript:alert(1)' }).success).toBe(
      false
    );
    expect(
      extensionMessageSchema.safeParse({ type: 'call', id: 1, method: 'eval', args: {} }).success
    ).toBe(false);
  });

  it('ships valid built-in extensions that ask only for what they use', () => {
    for (const ext of BUILT_IN_EXTENSIONS) {
      expect(extensionManifestSchema.parse(ext.manifest)).toEqual(ext.manifest);
      expect(extensionBundleSchema.safeParse(ext.bundle).success).toBe(true);
      expect(ext.manifest.scopes).not.toContain('records:write');
      // Every bundle compiles.
      expect(() => new Function(ext.bundle.js)).not.toThrow();
    }
    expect(builtInExtension('chart')?.manifest.scopes).toEqual(['records:read', 'settings:write']);
    expect(builtInExtension('nope')).toBeNull();
  });
});
