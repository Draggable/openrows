import {
  EXTENSION_LIMITS,
  EXTENSION_SCOPES,
  type ExtensionFrameGlobals,
  extensionFrameMain,
  extensionManifestSchema,
} from '@openrows/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOCK_SCOPES, type Block, initializeBlock, manifestProblems } from './index.js';

const T = '01900000-0000-7000-8000-000000000001';
const F = '01900000-0000-7000-8000-000000000002';

/** Runs the real frame runtime with a fake window and port; answers the API it sets. */
function frameApi(scopes: string[]) {
  const parent = {};
  let onMessage: ((e: unknown) => void) | undefined;
  const el = () => ({ textContent: '', innerHTML: '', appendChild: () => {}, setAttribute() {} });
  const g = {
    window: {
      parent,
      addEventListener(type: string, l: (e: unknown) => void) {
        if (type === 'message') onMessage = l;
      },
    } as unknown as ExtensionFrameGlobals['window'],
    document: { head: el(), body: el(), documentElement: el(), createElement: el },
    Function,
  };
  extensionFrameMain(g as unknown as ExtensionFrameGlobals);
  const sent: Record<string, unknown>[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (m: unknown) => sent.push(m as Record<string, unknown>),
  };
  onMessage?.({
    source: parent,
    ports: [port],
    data: {
      type: 'start',
      bundle: { html: '', css: '', js: '' },
      init: {
        installation: { id: T, name: 'Test' },
        scopes,
        theme: 'light',
        base: {
          id: T,
          name: 'Base',
          tables: [
            {
              id: T,
              name: 'Tasks',
              description: null,
              primaryFieldId: F,
              fields: [
                {
                  id: F,
                  name: 'Name',
                  type: 'text',
                  description: null,
                  options: {},
                  isComputed: false,
                },
              ],
              views: [],
            },
          ],
        },
        cursor: null,
        settings: {},
        canEditSettings: false,
        limits: EXTENSION_LIMITS,
      },
    },
  });
  return { block: (g.window as { openrows?: unknown }).openrows as Block, sent, port };
}

afterEach(() => {
  globalThis.openrows = undefined;
});

describe('initializeBlock', () => {
  it('answers the frame’s API, typed', async () => {
    const { block, sent, port } = frameApi(['records:read']);
    globalThis.openrows = block;
    const b = await initializeBlock();
    expect(b.hasScope('records:read')).toBe(true);
    expect(b.hasScope('records:write')).toBe(false);
    expect(b.getTable('Tasks').fields[0]?.name).toBe('Name');
    const p = b.selectRecords('Tasks', { fields: ['Name'], limit: 10 });
    expect(sent.at(-1)).toEqual({
      type: 'call',
      id: 1,
      method: 'select',
      args: { tableId: T, fieldIds: [F], limit: 10 },
    });
    port.onmessage?.({ data: { type: 'result', id: 1, ok: true, value: { records: [] } } });
    await expect(p).resolves.toEqual([]);
  });

  it('rejects outside an extension frame', async () => {
    await expect(initializeBlock()).rejects.toThrow('inside an OpenRows extension');
  });
});

describe('manifests', () => {
  it('knows the same scopes as OpenRows', () => {
    expect([...BLOCK_SCOPES]).toEqual([...EXTENSION_SCOPES]);
  });

  it('finds the problems the server would refuse', () => {
    const good = { manifestVersion: 1, name: 'Mine', scopes: ['records:read'] };
    expect(manifestProblems(good)).toEqual([]);
    expect(extensionManifestSchema.safeParse(good).success).toBe(true);
    const bad = { manifestVersion: 2, name: '', scopes: ['admin', 'admin'] };
    expect(manifestProblems(bad)).toEqual([
      'manifestVersion must be 1.',
      'name must be 1 to 100 characters.',
      'Unknown scope: admin.',
      'Unknown scope: admin.',
      'List each scope once.',
    ]);
    expect(extensionManifestSchema.safeParse(bad).success).toBe(false);
  });
});
