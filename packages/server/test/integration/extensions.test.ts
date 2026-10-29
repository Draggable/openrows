import { createHash } from 'node:crypto';
import {
  type Base,
  BUILT_IN_EXTENSIONS,
  builtInExtension,
  EXTENSION_EMBED_ORIGINS,
  EXTENSION_LIMITS,
  type ExtensionBundleResponse,
  type ExtensionInstallation,
  type ExtensionList,
  extensionFrameScript,
} from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { baseExtensions } from '../../src/db/index.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * Installed extensions: anyone on the base sees the panel, creators install, arrange and
 * remove extensions, editors change their settings. Built-ins come from shared; third-party
 * bundles follow EXTENSIONS_CUSTOM_BUNDLES (creators by default, owners on the hosted edition,
 * or off). The sandbox document is static, with a CSP that leaves the extension no origin,
 * storage or network beyond its manifest's `embed:frames`.
 */
describe('extensions', () => {
  const t = useTestDb();
  let app: ReturnType<typeof testApp>['app'];
  let owner: string;
  let creator: string;
  let editor: string;
  let commenter: string;
  let viewer: string;
  let stranger: string;
  let workspaceId: string;
  let base: Base;

  const request =
    (target: () => ReturnType<typeof testApp>['app']) =>
    (method: string, path: string, body?: unknown, as = owner) =>
      target().request(path, {
        method,
        headers: {
          origin: 'http://localhost:5173',
          'content-type': 'application/json',
          cookie: `${SESSION_COOKIE}=${as}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
  const json = request(() => app);
  async function ok<T>(res: Response | Promise<Response>, expected = 200): Promise<T> {
    const r = await res;
    if (r.status !== expected) throw new Error(`${r.status}: ${await r.text()}`);
    return (expected === 204 ? null : await r.json()) as T;
  }
  const custom = (name = 'Custom', scopes: string[] = ['records:read']) => ({
    manifest: { manifestVersion: 1, name, scopes },
    bundle: { html: '<p>Hi</p>', css: 'p{color:red}', js: 'openrows.base;' },
  });
  const path = () => `/api/bases/${base.id}/extensions`;

  beforeAll(async () => {
    ({ app } = testApp({ db: t.appDb }));
    const ws = await createWorkspace(t.db);
    workspaceId = ws.workspace.id;
    owner = await createSession(t.db, ws.owner);
    creator = await createSession(t.db, await addMember(t.db, workspaceId, 'creator'));
    editor = await createSession(t.db, await addMember(t.db, workspaceId, 'editor'));
    commenter = await createSession(t.db, await addMember(t.db, workspaceId, 'commenter'));
    viewer = await createSession(t.db, await addMember(t.db, workspaceId, 'read_only'));
    const other = await createWorkspace(t.db);
    stranger = await createSession(t.db, other.owner);
    base = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Ops' }),
      201
    );
  });

  it('installs built-ins, serves their bundle from the app, arranges, resizes and removes', async () => {
    const chart = await ok<ExtensionInstallation>(
      json('POST', path(), { builtIn: 'chart' }, creator),
      201
    );
    expect(chart).toMatchObject({
      builtIn: 'chart',
      name: 'Chart',
      size: 'medium',
      position: 0,
      settings: {},
      manifest: builtInExtension('chart')?.manifest,
    });
    const print = await ok<ExtensionInstallation>(
      json('POST', path(), { builtIn: 'print-view' }),
      201
    );
    expect(print.position).toBe(1);
    expect(
      await ok<ExtensionBundleResponse>(
        json('GET', `${path()}/${chart.id}/bundle`, undefined, viewer)
      )
    ).toEqual({
      manifest: builtInExtension('chart')?.manifest,
      bundle: builtInExtension('chart')?.bundle,
    });

    // Read-only members see the panel but may do nothing with it.
    const seen = await ok<ExtensionList>(json('GET', path(), undefined, viewer));
    expect(seen.extensions.map((e) => e.id)).toEqual([chart.id, print.id]);
    expect(seen).toMatchObject({ canManage: false, canConfigure: false, canInstallCustom: false });
    expect(await ok<ExtensionList>(json('GET', path(), undefined, editor))).toMatchObject({
      canManage: false,
      canConfigure: true,
    });
    expect(await ok<ExtensionList>(json('GET', path(), undefined, creator))).toMatchObject({
      canManage: true,
      canInstallCustom: true,
    });

    const reordered = await ok<ExtensionList>(
      json('PUT', `${path()}/order`, { ids: [print.id, chart.id] }, creator)
    );
    expect(reordered.extensions.map((e) => [e.id, e.position])).toEqual([
      [print.id, 0],
      [chart.id, 1],
    ]);
    for (const ids of [[print.id], [print.id, print.id], [print.id, chart.id, base.id]]) {
      expect((await json('PUT', `${path()}/order`, { ids }, creator)).status).toBe(422);
    }

    expect(
      await ok<ExtensionInstallation>(
        json('PATCH', `${path()}/${chart.id}`, { size: 'large', name: 'Sales chart' }, creator)
      )
    ).toMatchObject({ size: 'large', name: 'Sales chart' });
    expect((await json('PATCH', `${path()}/${chart.id}`, { size: 'huge' })).status).toBe(422);
    expect((await json('PATCH', `${path()}/${chart.id}`, { size: 'small' }, editor)).status).toBe(
      403
    );
    expect((await json('POST', path(), { builtIn: 'chart' }, editor)).status).toBe(403);
    expect((await json('POST', path(), { builtIn: 'nope' })).status).toBe(422);

    await ok(json('DELETE', `${path()}/${print.id}`, undefined, creator), 204);
    expect((await json('DELETE', `${path()}/${print.id}`)).status).toBe(404);
    await ok(json('DELETE', `${path()}/${chart.id}`), 204);
  });

  it('keeps settings per installation: editors change them, commenters may not', async () => {
    const chart = await ok<ExtensionInstallation>(json('POST', path(), { builtIn: 'chart' }), 201);
    const settings = { tableId: base.id, nested: { a: [1, 2] } };
    expect(
      await ok<ExtensionInstallation>(
        json('PUT', `${path()}/${chart.id}/settings`, { settings }, editor)
      )
    ).toMatchObject({ settings });
    expect(
      (await json('PUT', `${path()}/${chart.id}/settings`, { settings: {} }, commenter)).status
    ).toBe(403);
    const big = { blob: 'x'.repeat(EXTENSION_LIMITS.maxSettingsChars) };
    expect((await json('PUT', `${path()}/${chart.id}/settings`, { settings: big })).status).toBe(
      422
    );
    expect((await json('PUT', `${path()}/${chart.id}/settings`, { settings: [1] })).status).toBe(
      422
    );
    const list = await ok<ExtensionList>(json('GET', path(), undefined, commenter));
    expect(list.extensions.find((e) => e.id === chart.id)?.settings).toEqual(settings);
    await ok(json('DELETE', `${path()}/${chart.id}`), 204);
    // An extension without settings:write has no settings to change, even through the API.
    const reader = await ok<ExtensionInstallation>(json('POST', path(), custom('Reader')), 201);
    expect(
      (await json('PUT', `${path()}/${reader.id}/settings`, { settings: { a: 1 } })).status
    ).toBe(403);
    await ok(json('DELETE', `${path()}/${reader.id}`), 204);
  });

  it('installs a third-party bundle and serves it as uploaded', async () => {
    const ext = await ok<ExtensionInstallation>(json('POST', path(), custom('Mine'), creator), 201);
    expect(ext).toMatchObject({
      builtIn: null,
      name: 'Mine',
      manifest: { manifestVersion: 1, name: 'Mine', scopes: ['records:read'], version: '1.0.0' },
    });
    expect(
      await ok<ExtensionBundleResponse>(
        json('GET', `${path()}/${ext.id}/bundle`, undefined, viewer)
      )
    ).toMatchObject({ bundle: custom().bundle });
    // Invalid manifests and oversized bundles are refused.
    for (const body of [
      { ...custom(), manifest: { ...custom().manifest, scopes: ['admin'] } },
      { ...custom(), manifest: { ...custom().manifest, manifestVersion: 2 } },
      { ...custom(), bundle: { js: 'x'.repeat(EXTENSION_LIMITS.maxBundleChars + 1) } },
      { ...custom(), extra: true },
    ]) {
      expect((await json('POST', path(), body)).status).toBe(422);
    }
    const huge = { ...custom(), bundle: { js: '\u{1F600}'.repeat(1_200_000) } };
    expect((await json('POST', path(), huge)).status).toBe(413);
    await ok(json('DELETE', `${path()}/${ext.id}`), 204);
  });

  it('gates third-party bundles by EXTENSIONS_CUSTOM_BUNDLES', async () => {
    const owners = testApp({ db: t.appDb, env: { EXTENSIONS_CUSTOM_BUNDLES: 'owners' } }).app;
    const asOwners = request(() => owners);
    const refused = await asOwners('POST', path(), custom(), creator);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Only workspace owners');
    expect(await ok<ExtensionList>(asOwners('GET', path(), undefined, creator))).toMatchObject({
      canInstallCustom: false,
    });
    const mine = await ok<ExtensionInstallation>(asOwners('POST', path(), custom(), owner), 201);
    // Built-ins stay open to creators.
    const chart = await ok<ExtensionInstallation>(
      asOwners('POST', path(), { builtIn: 'chart' }, creator),
      201
    );

    const off = testApp({ db: t.appDb, env: { EXTENSIONS_CUSTOM_BUNDLES: 'off' } }).app;
    const asOff = request(() => off);
    expect((await asOff('POST', path(), custom(), owner)).status).toBe(403);
    expect(await ok<ExtensionList>(asOff('GET', path(), undefined, owner))).toMatchObject({
      canInstallCustom: false,
    });

    // The hosted edition's default is owners.
    const { loadConfig } = await import('../../src/config.js');
    expect(loadConfig({ NODE_ENV: 'test' }).extensionsCustomBundles).toBe('creators');
    expect(loadConfig({ NODE_ENV: 'test', EDITION: 'cloud' }).extensionsCustomBundles).toBe(
      'owners'
    );
    await ok(json('DELETE', `${path()}/${mine.id}`), 204);
    await ok(json('DELETE', `${path()}/${chart.id}`), 204);
  });

  it('caps a base at maxPerBase extensions', async () => {
    const other = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Full' }),
      201
    );
    await t.db.insert(baseExtensions).values(
      Array.from({ length: EXTENSION_LIMITS.maxPerBase }, (_, i) => ({
        workspaceId,
        baseId: other.id,
        builtIn: 'chart',
        name: `Chart ${i}`,
        manifest: BUILT_IN_EXTENSIONS[0]?.manifest ?? {},
        position: i,
      }))
    );
    const res = await json('POST', `/api/bases/${other.id}/extensions`, { builtIn: 'chart' });
    expect(res.status).toBe(409);
  });

  it("answers 404 for another tenant's base and extensions", async () => {
    const chart = await ok<ExtensionInstallation>(json('POST', path(), { builtIn: 'chart' }), 201);
    expect((await json('GET', path(), undefined, stranger)).status).toBe(404);
    expect((await json('GET', `${path()}/${chart.id}/bundle`, undefined, stranger)).status).toBe(
      404
    );
    expect(
      (await json('PUT', `${path()}/${chart.id}/settings`, { settings: {} }, stranger)).status
    ).toBe(404);
    // An extension id of another base in a base the caller can reach is a 404 too.
    const other = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Other' }),
      201
    );
    expect((await json('GET', `/api/bases/${other.id}/extensions/${chart.id}/bundle`)).status).toBe(
      404
    );
    await ok(json('DELETE', `${path()}/${chart.id}`), 204);
  });

  it('serves the sandbox document with a CSP that leaves it no origin, storage or network', async () => {
    const directives = (csp: string) =>
      Object.fromEntries(
        csp.split(';').map((d) => {
          const [name = '', ...values] = d.trim().split(/\s+/);
          return [name, values.join(' ')];
        })
      );
    const res = await app.request('/sandbox/extension');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const csp = res.headers.get('content-security-policy') ?? '';
    const hash = createHash('sha256').update(extensionFrameScript(), 'utf8').digest('base64');
    expect(directives(csp)).toMatchObject({
      'default-src': "'none'",
      'script-src': `'sha256-${hash}' 'unsafe-eval'`,
      'style-src': "'unsafe-inline'",
      'img-src': 'data: blob:',
      'frame-src': "'none'",
      'connect-src': "'none'",
      'worker-src': "'none'",
      'form-action': "'none'",
      'frame-ancestors': "'self'",
      sandbox: 'allow-scripts allow-modals',
    });
    expect(csp).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('set-cookie')).toBeNull();
    const html = await res.text();
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain(base.id);

    // embed:frames: https images and the embed providers' frames, nothing else.
    const embed = directives(
      (await app.request('/sandbox/extension?embed=1')).headers.get('content-security-policy') ?? ''
    );
    expect(embed).toMatchObject({
      'img-src': 'data: blob: https:',
      'frame-src': EXTENSION_EMBED_ORIGINS.join(' '),
      'connect-src': "'none'",
    });
    const other = directives(
      (await app.request('/sandbox/extension?embed=yes')).headers.get('content-security-policy') ??
        ''
    );
    expect(other['frame-src']).toBe("'none'");
  });
});
