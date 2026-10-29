import {
  type Base,
  MAX_SCRIPT_CODE_LENGTH,
  MAX_SCRIPTS_PER_BASE,
  type Script,
  type ScriptList,
  type TableMeta,
} from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { baseScripts } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Saved scripts: creators write a base's scripts, editors read them (to run them in the
 * browser), commenters and read-only members don't see them. The sandbox document is static,
 * with a CSP that leaves the script no origin, storage or network. A script's calls are the
 * normal records API as the runner, so table edit permissions still hold.
 */
describe('scripts', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  let owner: string;
  let creator: string;
  let editor: string;
  let viewer: string;
  let base: Base;
  let table: TableMeta;

  const json = (method: string, path: string, body?: unknown, as = owner) =>
    app.request(path, {
      method,
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${as}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function ok<T>(res: Response | Promise<Response>, expected = 200): Promise<T> {
    const r = await res;
    if (r.status !== expected) throw new Error(`${r.status}: ${await r.text()}`);
    return (expected === 204 ? null : await r.json()) as T;
  }

  beforeAll(async () => {
    ({ app } = testApp({ db: t.appDb }));
    const ws = await createWorkspace(t.db);
    owner = await createSession(t.db, ws.owner);
    creator = await createSession(t.db, await addMember(t.db, ws.workspace.id, 'creator'));
    editor = await createSession(t.db, await addMember(t.db, ws.workspace.id, 'editor'));
    viewer = await createSession(t.db, await addMember(t.db, ws.workspace.id, 'read_only'));
    base = await ok<Base>(
      json('POST', `/api/workspaces/${ws.workspace.id}/bases`, { name: 'Ops' }),
      201
    );
    table = await ok<TableMeta>(
      json('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
      201
    );
  });

  it('saves, lists by name, changes and deletes scripts', async () => {
    const path = `/api/bases/${base.id}/scripts`;
    const b = await ok<Script>(
      json('POST', path, { name: '  Bulk update ', code: "output.text('b');" }, creator),
      201
    );
    expect(b).toMatchObject({ name: 'Bulk update', description: '', baseId: base.id });
    const a = await ok<Script>(json('POST', path, { name: 'a report' }), 201);
    expect(a.code).toBe('');

    const list = await ok<ScriptList>(json('GET', path, undefined, editor));
    expect(list.canEdit).toBe(false);
    expect(list.scripts.map((s) => s.name)).toEqual(['a report', 'Bulk update']);
    expect((await ok<ScriptList>(json('GET', path, undefined, creator))).canEdit).toBe(true);
    expect(await ok<Script>(json('GET', `${path}/${b.id}`, undefined, editor))).toMatchObject({
      code: "output.text('b');",
    });

    const changed = await ok<Script>(
      json('PATCH', `${path}/${a.id}`, { code: 'output.text(1);', description: 'Counts' }, creator)
    );
    expect(changed).toMatchObject({
      name: 'a report',
      code: 'output.text(1);',
      description: 'Counts',
    });
    expect(changed.updatedAt >= a.updatedAt).toBe(true);

    await ok(json('DELETE', `${path}/${a.id}`, undefined, creator), 204);
    expect((await json('GET', `${path}/${a.id}`)).status).toBe(404);
    expect((await json('DELETE', `${path}/${a.id}`)).status).toBe(404);
  });

  it('lets editors read but not write, and hides scripts from read-only members', async () => {
    const path = `/api/bases/${base.id}/scripts`;
    const s = await ok<Script>(json('POST', path, { name: 'Guarded' }), 201);
    expect((await json('POST', path, { name: 'x' }, editor)).status).toBe(403);
    expect((await json('PATCH', `${path}/${s.id}`, { code: 'x' }, editor)).status).toBe(403);
    expect((await json('DELETE', `${path}/${s.id}`, undefined, editor)).status).toBe(403);
    expect((await json('GET', path, undefined, viewer)).status).toBe(403);
    expect((await json('GET', `${path}/${s.id}`, undefined, viewer)).status).toBe(403);
  });

  it("keeps a script to its base: another base's script id is a 404", async () => {
    const other = await ok<Base>(
      json('POST', `/api/workspaces/${base.workspaceId}/bases`, { name: 'Other' }),
      201
    );
    const s = await ok<Script>(
      json('POST', `/api/bases/${other.id}/scripts`, { name: 'Elsewhere' }),
      201
    );
    expect((await json('GET', `/api/bases/${base.id}/scripts/${s.id}`)).status).toBe(404);
    expect(
      (await json('PATCH', `/api/bases/${base.id}/scripts/${s.id}`, { name: 'x' })).status
    ).toBe(404);
    expect((await json('DELETE', `/api/bases/${base.id}/scripts/${s.id}`)).status).toBe(404);
  });

  it('validates names and code, and caps the scripts per base', async () => {
    const path = `/api/bases/${base.id}/scripts`;
    expect((await json('POST', path, { name: '  ' })).status).toBe(422);
    expect((await json('POST', path, { name: 'x', extra: 1 })).status).toBe(422);
    expect(
      (await json('POST', path, { name: 'x', code: 'a'.repeat(MAX_SCRIPT_CODE_LENGTH + 1) })).status
    ).toBe(422);
    const s = await ok<Script>(json('POST', path, { name: 'Valid' }), 201);
    expect((await json('PATCH', `${path}/${s.id}`, {})).status).toBe(422);

    const fresh = await ok<Base>(
      json('POST', `/api/workspaces/${base.workspaceId}/bases`, { name: 'Full' }),
      201
    );
    await t.db.insert(baseScripts).values(
      Array.from({ length: MAX_SCRIPTS_PER_BASE }, (_, i) => ({
        workspaceId: fresh.workspaceId,
        baseId: fresh.id,
        name: `S${i}`,
      }))
    );
    const full = await json('POST', `/api/bases/${fresh.id}/scripts`, { name: 'One more' });
    expect(full.status).toBe(409);
  });

  it("refuses a script's writes the runner may not make (the normal records API)", async () => {
    // Only creators add records to this table: an editor's script gets the API's 403.
    await ok(
      json('PATCH', `/api/tables/${table.id}`, {
        permissions: { addRecords: { level: 'creators' } },
      })
    );
    const res = await json(
      'POST',
      `/api/tables/${table.id}/records`,
      { records: [{ fields: {} }] },
      editor
    );
    expect(res.status).toBe(403);
    await ok(
      json('POST', `/api/tables/${table.id}/records`, { records: [{ fields: {} }] }, creator),
      201
    );
  });

  it('serves the sandbox document with a CSP that leaves it no origin, storage or network', async () => {
    const res = await app.request('/sandbox/script');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const csp = res.headers.get('content-security-policy') ?? '';
    const directives = Object.fromEntries(
      csp.split(';').map((d) => {
        const [name = '', ...values] = d.trim().split(/\s+/);
        return [name, values.join(' ')];
      })
    );
    expect(directives).toMatchObject({
      'default-src': "'none'",
      'worker-src': 'blob:',
      'connect-src': "'none'",
      'img-src': "'none'",
      'form-action': "'none'",
      'frame-ancestors': "'self'",
      sandbox: 'allow-scripts',
    });
    // allow-same-origin would give the frame the app's origin (cookies, storage, the API).
    expect(csp).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    expect(directives['script-src']).toMatch(/^'sha256-[A-Za-z0-9+/=]+' 'unsafe-eval'$/);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    const html = await res.text();
    expect(html.match(/<script>/g)).toHaveLength(1);
    // The document is the same for everyone: no cookie set, no data in it.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(html).not.toContain(base.id);
  });
});
