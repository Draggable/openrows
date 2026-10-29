import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CreatedShare,
  FieldMeta,
  Share,
  SharedRecord,
  SharedView,
  TableMeta,
  ViewMeta,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { shares, type users, views, workspaceMembers } from '../../src/db/index.js';
import { hashShareToken } from '../../src/shares/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createReadyAttachment,
  createSession,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';

/**
 * View share links and the prototype review's findings C8, H9, H10: the token is only
 * stored hashed, a link shows exactly its view (hidden fields never leave the server, the filter
 * can't be widened, nothing else of the base is reachable), and revoked, expired and unknown
 * links are the same 404.
 */
describe('view share links', () => {
  const t = useTestDb();
  const files = new MemoryObjectStore();
  let app: ReturnType<typeof testApp>['app'];
  let logs: ReturnType<typeof testApp>['logs'];
  let appUrl: string;
  let owner: typeof users.$inferSelect;
  let workspaceId: string;
  let cookie: string;

  const send = (method: string, path: string, body?: unknown, as: string | null = cookie) => {
    const headers = new Headers({ origin: appUrl });
    if (as) headers.set('cookie', `${SESSION_COOKIE}=${as}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  /** A signed-out visitor. */
  const visit = (path: string) => app.request(path, { headers: { origin: appUrl } });

  async function ok<T>(res: Response, status = 200): Promise<T> {
    if (res.status !== status) throw new Error(`${res.status}: ${await res.text()}`);
    return (status === 204 ? undefined : await res.json()) as T;
  }

  // A built client, so the server serves pages (the embed page).
  const clientDir = mkdtempSync(join(tmpdir(), 'openrows-shares-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>OpenRows</title>');
  afterAll(() => rmSync(clientDir, { recursive: true, force: true }));

  beforeAll(async () => {
    const built = testApp({
      db: t.appDb,
      objectStore: files,
      env: { SHARE_RATE_LIMIT: '100000', CLIENT_DIR: clientDir },
    });
    app = built.app;
    logs = built.logs;
    appUrl = built.config.appUrl;
    const tenant = await createWorkspace(t.db, {
      owner: await createUser(t.db, { name: 'Olive Owner' }),
    });
    owner = tenant.owner;
    workspaceId = tenant.workspace.id;
    cookie = await createSession(t.db, owner);
  });

  /**
   * A base with Tasks (Name, Notes, Status, Secret (hidden), Owner (user), Files, Project (link to
   * Projects)) and a Budget table; the grid hides Secret and shows only Status = Done.
   */
  async function fixture() {
    const base = await ok<{ id: string }>(
      await send('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Base' }),
      201
    );
    const table = await ok<TableMeta>(
      await send('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' }),
      201
    );
    const projects = await ok<TableMeta>(
      await send('POST', `/api/bases/${base.id}/tables`, { name: 'Projects' }),
      201
    );
    const budget = await ok<TableMeta>(
      await send('POST', `/api/bases/${base.id}/tables`, { name: 'Budget' }),
      201
    );
    const field = async (body: unknown) =>
      ok<FieldMeta>(await send('POST', `/api/tables/${table.id}/fields`, body), 201);
    const fieldsRes = await ok<{ fields: FieldMeta[] }>(
      await send('GET', `/api/tables/${table.id}`)
    );
    const byName = (n: string) => {
      const f = fieldsRes.fields.find((x) => x.name === n);
      if (!f) throw new Error(`no ${n}`);
      return f;
    };
    const name = byName('Name');
    const status = byName('Status');
    const secret = await field({ name: 'Secret', type: 'singleLineText' });
    const person = await field({ name: 'Owner', type: 'user' });
    const attachments = await field({ name: 'Files', type: 'attachment' });
    const hiddenFiles = await field({ name: 'Private files', type: 'attachment' });
    const project = await field({
      name: 'Project',
      type: 'link',
      options: { linkedTableId: projects.id },
    });
    const choices = (status.options as { choices: { id: string; name: string }[] }).choices;
    const done = choices.find((c) => c.name === 'Done');
    const todo = choices.find((c) => c.name === 'Todo');
    if (!done || !todo) throw new Error('no Done/Todo choices');

    const projectsFields = await ok<{ fields: FieldMeta[] }>(
      await send('GET', `/api/tables/${projects.id}`)
    );
    const projectName = projectsFields.fields.find((f) => f.isPrimary);
    if (!projectName) throw new Error('no project primary');
    const [apollo] = (
      await ok<{ records: { id: string }[] }>(
        await send('POST', `/api/tables/${projects.id}/records`, {
          records: [{ fields: { [projectName.id]: 'Apollo' } }],
        }),
        201
      )
    ).records;
    const budgetPrimary = (
      await ok<{ fields: FieldMeta[] }>(await send('GET', `/api/tables/${budget.id}`))
    ).fields.find((f) => f.isPrimary);
    await ok(
      await send('POST', `/api/tables/${budget.id}/records`, {
        records: [{ fields: { [budgetPrimary?.id ?? '']: 'Payroll' } }],
      }),
      201
    );

    const at = { workspaceId, baseId: base.id, tableId: table.id };
    const shown = await createReadyAttachment(
      t.db,
      { ...at, fieldId: attachments.id },
      { filename: 'shown.png', type: 'image/png', size: 3 }
    );
    const hiddenFile = await createReadyAttachment(
      t.db,
      { ...at, fieldId: hiddenFiles.id },
      { filename: 'hidden.png', type: 'image/png', size: 3 }
    );
    const filteredFile = await createReadyAttachment(
      t.db,
      { ...at, fieldId: attachments.id },
      { filename: 'filtered.png', type: 'image/png', size: 3 }
    );

    const { records } = await ok<{ records: { id: string }[] }>(
      await send('POST', `/api/tables/${table.id}/records`, {
        records: [
          {
            fields: {
              [name.id]: 'Ship it',
              [status.id]: done.id,
              [secret.id]: 'TOP-SECRET-VALUE',
              [person.id]: [owner.id],
              [attachments.id]: [shown],
              [hiddenFiles.id]: [hiddenFile],
              [project.id]: [apollo?.id],
            },
          },
          {
            fields: {
              [name.id]: 'Draft plan',
              [status.id]: todo.id,
              [secret.id]: 'ALSO-SECRET',
              [attachments.id]: [filteredFile],
            },
          },
        ],
      }),
      201
    );
    const { views: list } = await ok<{ views: ViewMeta[] }>(
      await send('GET', `/api/tables/${table.id}/views`)
    );
    const grid = list[0];
    if (!grid) throw new Error('no grid view');
    await ok(
      await send('PATCH', `/api/views/${grid.id}`, {
        grid: { hiddenFields: [secret.id, hiddenFiles.id], columnWidths: { [secret.id]: 300 } },
        query: {
          filter: { conditions: [{ fieldId: status.id, operator: 'is', value: done.id }] },
        },
      })
    );
    const other = await ok<ViewMeta>(
      await send('POST', `/api/tables/${table.id}/views`, { name: 'Everything' }),
      201
    );
    return {
      base,
      table,
      budget,
      grid,
      other,
      fields: { name, status, secret, person, attachments, hiddenFiles, project },
      files: { shown, hiddenFile, filteredFile },
      records,
    };
  }

  async function share(viewId: string, body: unknown = {}) {
    return ok<CreatedShare>(await send('POST', `/api/views/${viewId}/shares`, body), 201);
  }

  it('stores only the SHA-256 of a 256-bit token and shows the token once', async () => {
    const f = await fixture();
    const created = await share(f.grid.id);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(created.token, 'base64url')).toHaveLength(32);
    const rows = await t.db.select().from(shares).where(eq(shares.id, created.share.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashShareToken(created.token));
    expect(JSON.stringify(rows)).not.toContain(created.token);
    const { shares: listed } = await ok<{ shares: Share[] }>(
      await send('GET', `/api/views/${f.grid.id}/shares`)
    );
    expect(listed.map((s) => s.id)).toEqual([created.share.id]);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    // Never logged: the request lines show `/api/shared/:token`.
    await ok(await visit(`/api/shared/${created.token}`));
    expect(JSON.stringify(logs)).not.toContain(created.token);
    expect(logs.some((l) => l['path'] === '/api/shared/:token')).toBe(true);
  });

  it('shows the view to anyone with the link, without hidden fields or ids of others', async () => {
    const f = await fixture();
    const { token } = await share(f.grid.id);
    const viewRes = await visit(`/api/shared/${token}/views/${f.grid.id}`);
    expect(viewRes.status).toBe(200);
    expect(viewRes.headers.get('referrer-policy')).toBe('no-referrer');
    expect(viewRes.headers.get('x-robots-tag')).toContain('noindex');
    expect(viewRes.headers.get('cache-control')).toBe('private, no-store');
    const viewText = await viewRes.text();
    const shown = JSON.parse(viewText) as SharedView;
    expect(shown.view).toEqual({ name: f.grid.name, type: 'grid' });
    expect(shown.table).toEqual({ name: 'Tasks' });
    expect(shown.fields.map((x) => x.name)).toEqual([
      'Name',
      'Notes',
      'Status',
      'Owner',
      'Files',
      'Project',
    ]);
    // The link's options don't name the linked table.
    expect(shown.fields.find((x) => x.name === 'Project')?.options).toEqual({
      prefersSingleRecordLink: false,
    });

    const recordsRes = await visit(`/api/shared/${token}/views/${f.grid.id}/records`);
    const recordsText = await recordsRes.text();
    const page = JSON.parse(recordsText) as { records: SharedRecord[]; total: number };
    expect(page.total).toBe(1);
    expect(page.records).toHaveLength(1);
    const [record] = page.records;
    expect(record?.fields[f.fields.name.id]).toBe('Ship it');
    expect(record?.fields[f.fields.person.id]).toEqual(['Olive Owner']);
    expect(record?.fields[f.fields.project.id]).toEqual(['Apollo']);
    expect(record?.fields[f.fields.attachments.id]).toMatchObject([{ filename: 'shown.png' }]);

    for (const text of [viewText, recordsText]) {
      for (const hidden of [
        f.fields.secret.id,
        f.fields.hiddenFiles.id,
        'TOP-SECRET-VALUE',
        'hidden.png',
        owner.id,
        owner.email ?? 'no-email',
        workspaceId,
        f.base.id,
        f.table.id,
        f.grid.id,
      ]) {
        expect(text, hidden).not.toContain(hidden);
      }
    }
  });

  it("applies the view's filter and refuses anything that would widen it", async () => {
    const f = await fixture();
    const { token } = await share(f.grid.id);
    for (const q of [
      `filter=${encodeURIComponent('{"conditions":[]}')}`,
      `viewId=${f.other.id}`,
      `fields=${f.fields.secret.id}`,
      'search=Draft',
      `tableId=${f.budget.id}`,
    ]) {
      const res = await visit(`/api/shared/${token}/views/${f.grid.id}/records?${q}`);
      expect(res.status, q).toBe(422);
      expect(await res.text(), q).not.toContain('Draft plan');
    }
    const page = await ok<{ total: number; records: SharedRecord[] }>(
      await visit(`/api/shared/${token}/views/${f.grid.id}/records?offset=0&limit=200`)
    );
    expect(page.total).toBe(1);
    expect(JSON.stringify(page)).not.toContain('Draft plan');
    expect((await visit(`/api/shared/${token}/views/${f.grid.id}/records?limit=201`)).status).toBe(
      422
    );

    // A filter on `me` means the visitor, who is nobody.
    await ok(
      await send('PATCH', `/api/views/${f.grid.id}`, {
        query: {
          filter: {
            conditions: [{ fieldId: f.fields.person.id, operator: 'hasAnyOf', value: ['me'] }],
          },
        },
      })
    );
    const mine = await ok<{ total: number }>(
      await visit(`/api/shared/${token}/views/${f.grid.id}/records`)
    );
    expect(mine.total).toBe(0);
  });

  it('downloads only files the view shows, through short-lived signed URLs', async () => {
    const f = await fixture();
    const { token } = await share(f.grid.id);
    const file = (id: string, thumb = false) =>
      visit(
        `/api/shared/${token}/views/${f.grid.id}/attachments/${id}${thumb ? '/thumbnail' : ''}`
      );
    const res = await file(f.files.shown.id);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(f.files.shown.id);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await file(f.files.shown.id, true)).status).toBe(302);
    // A hidden field's file, a filtered-out record's file, a malformed id: all 404.
    expect((await file(f.files.hiddenFile.id)).status).toBe(404);
    expect((await file(f.files.filteredFile.id)).status).toBe(404);
    expect((await file('not-a-uuid')).status).toBe(404);
  });

  it('answers the same 404 for unknown, malformed, revoked and expired links', async () => {
    const f = await fixture();
    const revoked = await share(f.grid.id);
    const expired = await share(f.grid.id);
    await ok(await send('DELETE', `/api/views/${f.grid.id}/shares/${revoked.share.id}`), 204);
    await t.db
      .update(shares)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(shares.id, expired.share.id));
    const unknown = 'A'.repeat(43);
    const bodies = new Set<string>();
    for (const token of [revoked.token, expired.token, unknown, 'short']) {
      for (const path of [
        `/api/shared/${token}`,
        `/api/shared/${token}/views/${f.grid.id}`,
        `/api/shared/${token}/views/${f.grid.id}/records`,
        `/api/shared/${token}/views/${f.grid.id}/export.csv`,
        `/api/shared/${token}/views/${f.grid.id}/attachments/${f.files.shown.id}`,
      ]) {
        const res = await visit(path);
        expect(res.status, path).toBe(404);
        const body = (await res.json()) as { detail?: string; instance?: string };
        expect(body.instance).not.toContain(token);
        bodies.add(body.detail ?? '');
      }
    }
    expect([...bodies]).toEqual(['No such share link.']);
    // The revoked link isn't listed; revoking again is a 404.
    const { shares: listed } = await ok<{ shares: Share[] }>(
      await send('GET', `/api/views/${f.grid.id}/shares`)
    );
    expect(listed.map((s) => [s.id, s.expired])).toEqual([[expired.share.id, true]]);
    expect(
      (await send('DELETE', `/api/views/${f.grid.id}/shares/${revoked.share.id}`)).status
    ).toBe(404);
  });

  it('stops answering when the view goes, or its maker can no longer share it', async () => {
    const f = await fixture();
    const creator = await addMember(t.db, workspaceId, 'creator');
    const creatorCookie = await createSession(t.db, creator);
    const theirs = await ok<CreatedShare>(
      await send('POST', `/api/views/${f.grid.id}/shares`, {}, creatorCookie),
      201
    );
    const mine = await share(f.grid.id);
    expect((await visit(`/api/shared/${theirs.token}`)).status).toBe(200);
    // Demoted to editor: their link stops, the owner's stays.
    await t.db
      .update(workspaceMembers)
      .set({ role: 'editor' })
      .where(eq(workspaceMembers.userId, creator.id));
    expect((await visit(`/api/shared/${theirs.token}`)).status).toBe(404);
    expect((await visit(`/api/shared/${mine.token}`)).status).toBe(200);
    // A view made personal by someone else hides it from the owner's link too.
    await t.db
      .update(views)
      .set({ personal: true, createdBy: creator.id })
      .where(eq(views.id, f.grid.id));
    expect((await visit(`/api/shared/${mine.token}`)).status).toBe(404);
    await t.db.update(views).set({ personal: false }).where(eq(views.id, f.grid.id));
    expect((await visit(`/api/shared/${mine.token}`)).status).toBe(200);
    // Deleting the view (trash) ends it.
    await t.db.update(views).set({ deletedAt: new Date() }).where(eq(views.id, f.grid.id));
    expect((await visit(`/api/shared/${mine.token}`)).status).toBe(404);
  });

  it('checks the expiry, the view type and the cap when making a link', async () => {
    const f = await fixture();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect((await send('POST', `/api/views/${f.grid.id}/shares`, { expiresAt: past })).status).toBe(
      422
    );
    const far = new Date(Date.now() + 4000 * 86_400_000).toISOString();
    expect((await send('POST', `/api/views/${f.grid.id}/shares`, { expiresAt: far })).status).toBe(
      422
    );
    expect(
      (await send('POST', `/api/views/${f.grid.id}/shares`, { token: 'mine-now' })).status
    ).toBe(422);
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const dated = await share(f.grid.id, { expiresAt: soon });
    expect(dated.share.expiresAt).toBe(soon);
    expect(dated.share.expired).toBe(false);
    const { expiresAt } = await ok<SharedView>(
      await visit(`/api/shared/${dated.token}/views/${f.grid.id}`)
    );
    expect(expiresAt).toBe(soon);

    const kanban = await ok<ViewMeta>(
      await send('POST', `/api/tables/${f.table.id}/views`, { name: 'Board', type: 'kanban' }),
      201
    );
    // Every layout can be shared since (shared-layouts.test.ts).
    expect((await send('POST', `/api/views/${kanban.id}/shares`, {})).status).toBe(201);

    for (let i = 1; i < 20; i++) await share(f.grid.id);
    expect((await send('POST', `/api/views/${f.grid.id}/shares`, {})).status).toBe(409);
  });

  it('keeps links to their workspace (RLS) and other workspaces out', async () => {
    const f = await fixture();
    const { token, share: made } = await share(f.grid.id);
    const other = await createWorkspace(t.db);
    const otherCookie = await createSession(t.db, other.owner);
    expect(
      (await send('GET', `/api/views/${f.grid.id}/shares`, undefined, otherCookie)).status
    ).toBe(404);
    expect(
      (await send('DELETE', `/api/views/${f.grid.id}/shares/${made.id}`, undefined, otherCookie))
        .status
    ).toBe(404);
    // The app role sees no share row outside the workspace in scope.
    const seen = await t.appDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.workspace_id', ${other.workspace.id}, true)`);
      return tx.select().from(shares);
    });
    expect(seen).toEqual([]);
    expect((await visit(`/api/shared/${token}`)).status).toBe(200);
  });

  // ----: passwords, email domains, toggles, base links ------------------------------------

  /** A signed-out (or signed-in, with `session`) visitor carrying an unlock cookie. */
  const visitWith = (path: string, shareCookie?: string, session?: string) => {
    const cookies = [
      ...(shareCookie ? [`openrows_share=${shareCookie}`] : []),
      ...(session ? [`${SESSION_COOKIE}=${session}`] : []),
    ];
    return app.request(path, {
      headers: { origin: appUrl, ...(cookies.length ? { cookie: cookies.join('; ') } : {}) },
    });
  };
  const unlock = (token: string, password: string, session?: string) =>
    app.request(`/api/shared/${token}/unlock`, {
      method: 'POST',
      headers: {
        origin: appUrl,
        'content-type': 'application/json',
        ...(session ? { cookie: `${SESSION_COOKIE}=${session}` } : {}),
      },
      body: JSON.stringify({ password }),
    });
  /** The unlock cookie's value and attributes from a Set-Cookie header. */
  function shareCookieOf(res: Response): { value: string; attrs: string } {
    const header = res.headers.get('set-cookie') ?? '';
    const m = /openrows_share=([^;]*)(.*)$/.exec(header);
    if (!m?.[1]) throw new Error(`no share cookie in ${header}`);
    return { value: m[1], attrs: m[2] ?? '' };
  }
  const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;
  /** Every public path of a view link. */
  const dataPaths = (token: string, f: Awaited<ReturnType<typeof fixture>>) => [
    `/api/shared/${token}`,
    `/api/shared/${token}/views/${f.grid.id}`,
    `/api/shared/${token}/views/${f.grid.id}/records`,
    `/api/shared/${token}/views/${f.grid.id}/export.csv`,
    `/api/shared/${token}/views/${f.grid.id}/attachments/${f.files.shown.id}`,
  ];

  it('stores a password only as an argon2id hash and never answers data without it', async () => {
    const f = await fixture();
    const password = 'correct horse battery';
    const { token, share: made } = await share(f.grid.id, { password, allowDownload: true });
    expect(made.hasPassword).toBe(true);
    const [row] = await t.db.select().from(shares).where(eq(shares.id, made.id));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(JSON.stringify(made)).not.toContain('argon2');
    // Only salted argon2id hashes fit the column.
    await expect(
      t.db
        .update(shares)
        .set({ passwordHash: 'e3b0c44298fc1c149afbf4c8996fb924' })
        .where(eq(shares.id, made.id))
    ).rejects.toThrow();

    const refusedEverywhere = async (shareCookie?: string) => {
      for (const path of dataPaths(token, f)) {
        const res = await visitWith(path, shareCookie);
        expect(res.status, path).toBe(401);
        const text = await res.text();
        expect(JSON.parse(text).code).toBe('SHARE_PASSWORD_REQUIRED');
        for (const leak of ['Ship it', 'Tasks', f.grid.name, 'Status', 'shown.png']) {
          expect(text, `${path} leaks ${leak}`).not.toContain(leak);
        }
      }
    };
    await refusedEverywhere();

    // A wrong password: 401, no cookie, still nothing.
    for (const wrong of ['correct horse battery ', 'CORRECT HORSE BATTERY', 'x']) {
      const res = await unlock(token, wrong);
      expect(res.status).toBe(401);
      expect(await codeOf(res)).toBe('SHARE_PASSWORD_INCORRECT');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    await refusedEverywhere();
    // Forged and malformed cookies don't open it either.
    await refusedEverywhere(`v1.${made.id}.0.9999999999.AAAA`);
    await refusedEverywhere('garbage');

    const res = await unlock(token, password);
    expect(res.status).toBe(204);
    const cookie = shareCookieOf(res);
    expect(cookie.attrs).toContain('HttpOnly');
    expect(cookie.attrs).toContain('SameSite=Lax');
    expect(cookie.attrs).toContain(`Path=/api/shared/${token}`);
    const expires = Date.parse(/Expires=([^;]+)/.exec(cookie.attrs)?.[1] ?? '');
    expect(expires).toBeGreaterThan(Date.now() + 11 * 3_600_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 12 * 3_600_000 + 1000);
    expect(cookie.value).not.toContain(password);

    for (const path of dataPaths(token, f)) {
      const status = (await visitWith(path, cookie.value)).status;
      expect(status, path).toBe(path.includes('/attachments/') ? 302 : 200);
    }
    // A tampered signature, share id or version is refused.
    const [v, id, version, exp, tag] = cookie.value.split('.');
    for (const forged of [
      `${v}.${id}.${version}.${exp}.${tag?.slice(1)}A`,
      `${v}.${id}.${Number(version) + 1}.${exp}.${tag}`,
      `${v}.${id}.${version}.${Number(exp) + 3600}.${tag}`,
    ]) {
      expect((await visitWith(`/api/shared/${token}`, forged)).status).toBe(401);
    }
  });

  it("doesn't open share B with share A's cookie", async () => {
    const f = await fixture();
    const password = 'same password for both';
    const a = await share(f.grid.id, { password });
    const b = await share(f.grid.id, { password });
    const cookieA = shareCookieOf(await unlock(a.token, password)).value;
    expect((await visitWith(`/api/shared/${a.token}`, cookieA)).status).toBe(200);
    for (const path of dataPaths(b.token, f)) {
      const res = await visitWith(path, cookieA);
      expect(res.status, path).toBe(401);
      expect(await codeOf(res)).toBe('SHARE_PASSWORD_REQUIRED');
    }
    // A base link of the same base, with the same password, doesn't take it either.
    const baseLink = await ok<CreatedShare>(
      await send('POST', `/api/bases/${f.base.id}/shares`, { password }),
      201
    );
    expect((await visitWith(`/api/shared/${baseLink.token}`, cookieA)).status).toBe(401);
  });

  it('ends every unlock when the password changes, and opens up when it is removed', async () => {
    const f = await fixture();
    const { token, share: made } = await share(f.grid.id, { password: 'first password' });
    const old = shareCookieOf(await unlock(token, 'first password')).value;
    expect((await visitWith(`/api/shared/${token}`, old)).status).toBe(200);

    const changed = await ok<Share>(
      await send('PATCH', `/api/views/${f.grid.id}/shares/${made.id}`, {
        password: 'second password',
      })
    );
    expect(changed.hasPassword).toBe(true);
    expect((await visitWith(`/api/shared/${token}`, old)).status).toBe(401);
    expect((await unlock(token, 'first password')).status).toBe(401);
    const fresh = shareCookieOf(await unlock(token, 'second password')).value;
    expect((await visitWith(`/api/shared/${token}`, fresh)).status).toBe(200);

    // Too short a password is refused; null removes it.
    expect(
      (await send('PATCH', `/api/views/${f.grid.id}/shares/${made.id}`, { password: 'short' }))
        .status
    ).toBe(422);
    await ok(await send('PATCH', `/api/views/${f.grid.id}/shares/${made.id}`, { password: null }));
    expect((await visit(`/api/shared/${token}`)).status).toBe(200);
    // Unlocking a link without a password sets nothing.
    const none = await unlock(token, 'whatever');
    expect(none.status).toBe(204);
    expect(none.headers.get('set-cookie')).toBeNull();
  });

  it("lets an unlock last no longer than the link's own expiry", async () => {
    const f = await fixture();
    const soon = new Date(Date.now() + 3_600_000);
    const { token } = await share(f.grid.id, {
      password: 'expiring password',
      expiresAt: soon.toISOString(),
    });
    const { attrs } = shareCookieOf(await unlock(token, 'expiring password'));
    const expires = Date.parse(/Expires=([^;]+)/.exec(attrs)?.[1] ?? '');
    expect(Math.abs(expires - soon.getTime())).toBeLessThan(1500);
  });

  it('limits password attempts per link and client', async () => {
    const f = await fixture();
    const { token } = await share(f.grid.id, { password: 'the real password' });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await unlock(token, `guess ${i}`)).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
    // Even the right password waits now.
    expect((await unlock(token, 'the real password')).status).toBe(429);
    // Another link isn't affected.
    const other = await share(f.grid.id, { password: 'the real password' });
    expect((await unlock(other.token, 'the real password')).status).toBe(204);
  });

  it('admits only signed-in viewers with a verified email at an allowed domain', async () => {
    const f = await fixture();
    const { token, share: made } = await share(f.grid.id, {
      allowedDomains: ['Example.com', 'example.com', 'partner.org'],
    });
    expect(made.allowedDomains).toEqual(['example.com', 'partner.org']);
    const viewer = async (email: string, emailVerified = true) =>
      createSession(t.db, await createUser(t.db, { email, emailVerified }));

    const anonymous = await visit(`/api/shared/${token}`);
    expect(anonymous.status).toBe(401);
    expect(await codeOf(anonymous)).toBe('SHARE_SIGN_IN_REQUIRED');

    for (const email of ['alice@example.com', 'Bob@EXAMPLE.COM', 'pat@partner.org']) {
      const session = await viewer(email);
      for (const path of dataPaths(token, f).slice(0, 3)) {
        expect((await visitWith(path, undefined, session)).status, `${email} ${path}`).toBe(200);
      }
    }
    for (const [email, verified] of [
      ['eve@evil-example.com', true],
      ['eve@notexample.com', true],
      ['eve@mail.example.com', true],
      ['eve@example.com.evil.org', true],
      ['eve@example.co', true],
      ['"eve@example.com"@evil.org', true],
      ['dave@example.com', false],
    ] as const) {
      const session = await viewer(email, verified);
      for (const path of dataPaths(token, f)) {
        const res = await visitWith(path, undefined, session);
        expect(res.status, `${email} ${path}`).toBe(403);
        const text = await res.text();
        expect(JSON.parse(text).code).toBe('SHARE_DOMAIN_NOT_ALLOWED');
        expect(text).not.toContain('Ship it');
      }
    }
    // A stale or forged session cookie is no one.
    expect((await visitWith(`/api/shared/${token}`, undefined, 'forged')).status).toBe(401);

    // Domains are checked before the password: outsiders can't even try one.
    await ok(
      await send('PATCH', `/api/views/${f.grid.id}/shares/${made.id}`, {
        password: 'domain and password',
      })
    );
    const outsider = await viewer('eve@evil-example.com');
    expect(await codeOf(await unlock(token, 'domain and password', outsider))).toBe(
      'SHARE_DOMAIN_NOT_ALLOWED'
    );
    expect(await codeOf(await unlock(token, 'domain and password'))).toBe('SHARE_SIGN_IN_REQUIRED');
    const insider = await viewer('carol@example.com');
    const res = await unlock(token, 'domain and password', insider);
    expect(res.status).toBe(204);
    const cookie = shareCookieOf(res).value;
    expect((await visitWith(`/api/shared/${token}`, cookie, insider)).status).toBe(200);
    // The password cookie alone, signed out, isn't enough.
    expect((await visitWith(`/api/shared/${token}`, cookie)).status).toBe(401);
    expect((await visitWith(`/api/shared/${token}`, cookie, outsider)).status).toBe(403);
  });

  it('validates and caps the allowed domains', async () => {
    const f = await fixture();
    for (const allowedDomains of [
      ['*.example.com'],
      ['@example.com'],
      ['example'],
      ['exa mple.com'],
      ['https://example.com'],
      ['127.0.0.1'],
      Array.from({ length: 21 }, (_, i) => `d${i}.example.com`),
    ]) {
      expect(
        (await send('POST', `/api/views/${f.grid.id}/shares`, { allowedDomains })).status,
        JSON.stringify(allowedDomains)
      ).toBe(422);
    }
    const twenty = Array.from({ length: 20 }, (_, i) => `d${i}.example.com`);
    expect((await share(f.grid.id, { allowedDomains: twenty })).share.allowedDomains).toEqual(
      twenty
    );
  });

  /** The frame-ancestors sources of a response, and whether it sends X-Frame-Options. */
  function framing(res: Response) {
    const csp = res.headers.get('content-security-policy') ?? '';
    const directive = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('frame-ancestors '));
    return {
      ancestors: directive?.split(/\s+/).slice(1) ?? [],
      xfo: res.headers.get('x-frame-options'),
    };
  }
  const NOT_FRAMED = { ancestors: ["'none'"], xfo: 'DENY' };

  it('lets only the embed origins of a link frame its embed page (#99)', async () => {
    const f = await fixture();
    const { share: made, token } = await share(f.grid.id, {
      embedOrigins: ['https://Intranet.Example.com/', 'https://wiki.example.org:8443'],
    });
    expect(made.embedOrigins).toEqual([
      'https://intranet.example.com',
      'https://wiki.example.org:8443',
    ]);
    expect(made.allowRestrictedEmbed).toBe(false);

    const page = await visit(`/embed/${token}?theme=dark`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(framing(page)).toEqual({
      ancestors: ['https://intranet.example.com', 'https://wiki.example.org:8443'],
      xfo: null,
    });
    // The rest of the share policy holds.
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('content-security-policy')).toContain("form-action 'none'");
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');

    // Everything else still refuses framing: the same link's page and API, and the app.
    for (const path of [
      `/s/${token}`,
      `/api/shared/${token}`,
      `/api/shared/${token}/views/${f.grid.id}`,
      `/embed/${token}/more`,
      '/',
      `/bases/${f.base.id}`,
      '/api/me',
      '/api/openapi.json',
      '/health',
    ]) {
      expect(framing(await visit(path)), path).toEqual(NOT_FRAMED);
    }

    // A whole-base link embeds the same way.
    const baseLink = await ok<CreatedShare>(
      await send('POST', `/api/bases/${f.base.id}/shares`, {
        embedOrigins: ['https://intranet.example.com'],
      }),
      201
    );
    expect(framing(await visit(`/embed/${baseLink.token}`))).toEqual({
      ancestors: ['https://intranet.example.com'],
      xfo: null,
    });

    // A link without embed origins, an unknown or malformed token: never framed.
    const plain = await share(f.grid.id);
    expect(plain.share.embedOrigins).toEqual([]);
    for (const path of [`/embed/${plain.token}`, `/embed/${'C'.repeat(43)}`, '/embed/short']) {
      const res = await visit(path);
      expect(res.status, path).toBe(200);
      expect(framing(res), path).toEqual(NOT_FRAMED);
    }

    // Changing the origins applies on the next load; removing them, or revoking, ends it.
    await ok(
      await send('PATCH', `/api/views/${f.grid.id}/shares/${made.id}`, {
        embedOrigins: ['https://new.example.net'],
      })
    );
    expect(framing(await visit(`/embed/${token}`)).ancestors).toEqual(['https://new.example.net']);
    await ok(
      await send('PATCH', `/api/views/${f.grid.id}/shares/${made.id}`, { embedOrigins: [] })
    );
    expect(framing(await visit(`/embed/${token}`))).toEqual(NOT_FRAMED);
    await ok(
      await send('PATCH', `/api/views/${f.grid.id}/shares/${made.id}`, {
        embedOrigins: ['https://new.example.net'],
      })
    );
    await ok(await send('DELETE', `/api/views/${f.grid.id}/shares/${made.id}`), 204);
    expect(framing(await visit(`/embed/${token}`))).toEqual(NOT_FRAMED);
  });

  it('frames password and domain links only when their maker allowed it (#99)', async () => {
    const f = await fixture();
    const origins = ['https://intranet.example.com'];
    const locked = await share(f.grid.id, { embedOrigins: origins, password: 'correct horse' });
    const domains = await share(f.grid.id, {
      embedOrigins: origins,
      allowedDomains: ['example.com'],
    });
    for (const { token } of [locked, domains]) {
      expect(framing(await visit(`/embed/${token}`))).toEqual(NOT_FRAMED);
    }
    for (const { share: s, token } of [locked, domains]) {
      const updated = await ok<Share>(
        await send('PATCH', `/api/views/${f.grid.id}/shares/${s.id}`, {
          allowRestrictedEmbed: true,
        })
      );
      expect(updated.allowRestrictedEmbed).toBe(true);
      expect(framing(await visit(`/embed/${token}`))).toEqual({ ancestors: origins, xfo: null });
      // Framing is all it changes: the data still needs the password or the domain.
      expect((await visit(`/api/shared/${token}`)).status).toBe(401);
    }
    // Removing the password makes the link unrestricted; adding one back restricts it again.
    const plain = await share(f.grid.id, { embedOrigins: origins });
    expect(framing(await visit(`/embed/${plain.token}`)).ancestors).toEqual(origins);
    await ok(
      await send('PATCH', `/api/views/${f.grid.id}/shares/${plain.share.id}`, {
        password: 'a new password',
      })
    );
    expect(framing(await visit(`/embed/${plain.token}`))).toEqual(NOT_FRAMED);
  });

  it('validates and caps the embed origins (#99)', async () => {
    const f = await fixture();
    for (const embedOrigins of [
      ['http://example.com'],
      ['example.com'],
      ['https://*.example.com'],
      ['https://example.com/path'],
      ['https://user@example.com'],
      ['https://10.0.0.1'],
      ["'self'"],
      ['*'],
      ["https://example.com 'unsafe-inline'"],
      ['https://example.com; script-src *'],
      Array.from({ length: 21 }, (_, i) => `https://d${i}.example.com`),
    ]) {
      expect(
        (await send('POST', `/api/views/${f.grid.id}/shares`, { embedOrigins })).status,
        JSON.stringify(embedOrigins)
      ).toBe(422);
    }
    const twenty = Array.from({ length: 20 }, (_, i) => `https://d${i}.example.com`);
    expect((await share(f.grid.id, { embedOrigins: twenty })).share.embedOrigins).toEqual(twenty);
    // The database holds the cap too.
    await expect(
      t.db.execute(
        sql`UPDATE shares SET embed_origins = array_fill('https://x.example'::text, ARRAY[21])`
      )
    ).rejects.toThrow();
  });

  it('downloads CSV only when the link allows it, with the same projection', async () => {
    const f = await fixture();
    const off = await share(f.grid.id);
    expect(off.share.allowDownload).toBe(false);
    expect(off.share.allowCopy).toBe(true);
    const refused = await visit(`/api/shared/${off.token}/views/${f.grid.id}/export.csv`);
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe('SHARE_DOWNLOAD_DISABLED');

    const on = await share(f.grid.id, { allowDownload: true, allowCopy: false });
    const summary = await ok<{ allowCopy: boolean; allowDownload: boolean }>(
      await visit(`/api/shared/${on.token}`)
    );
    expect(summary).toMatchObject({ allowCopy: false, allowDownload: true });
    const res = await visit(`/api/shared/${on.token}/views/${f.grid.id}/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const csv = await res.text();
    const [header, ...rows] = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(header).toBe('Name,Notes,Status,Owner,Files,Project');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Ship it');
    expect(rows[0]).toContain('Olive Owner');
    expect(rows[0]).toContain('Apollo');
    for (const hidden of ['TOP-SECRET-VALUE', 'Draft plan', 'hidden.png', owner.id]) {
      expect(csv).not.toContain(hidden);
    }
    // Turned off again: refused at once.
    await ok(
      await send('PATCH', `/api/views/${f.grid.id}/shares/${on.share.id}`, {
        allowDownload: false,
      })
    );
    expect((await visit(`/api/shared/${on.token}/views/${f.grid.id}/export.csv`)).status).toBe(403);
  });

  it('shares a whole base: every table and non-personal view, each with its projection', async () => {
    const f = await fixture();
    const personal = await ok<ViewMeta>(
      await send('POST', `/api/tables/${f.table.id}/views`, { name: 'Mine', personal: true }),
      201
    );
    const form = await ok<ViewMeta>(
      await send('POST', `/api/tables/${f.table.id}/views`, { name: 'Intake', type: 'form' }),
      201
    );
    const editor = await addMember(t.db, workspaceId, 'editor');
    const editorCookie = await createSession(t.db, editor);
    expect((await send('POST', `/api/bases/${f.base.id}/shares`, {}, editorCookie)).status).toBe(
      403
    );
    const { token, share: made } = await ok<CreatedShare>(
      await send('POST', `/api/bases/${f.base.id}/shares`, {}),
      201
    );
    expect(made).toMatchObject({ kind: 'base', viewId: null, baseId: f.base.id });
    const { shares: listed } = await ok<{ shares: Share[] }>(
      await send('GET', `/api/bases/${f.base.id}/shares`)
    );
    expect(listed.map((s) => s.id)).toEqual([made.id]);
    // The view's own list doesn't show base links.
    const { shares: viewLinks } = await ok<{ shares: Share[] }>(
      await send('GET', `/api/views/${f.grid.id}/shares`)
    );
    expect(viewLinks).toEqual([]);

    const summary = await ok<{
      kind: string;
      name: string;
      tables: { name: string; views: { id: string; name: string }[] }[];
    }>(await visit(`/api/shared/${token}`));
    expect(summary.kind).toBe('base');
    expect(summary.name).toBe('Base');
    expect(summary.tables.map((x) => [x.name, x.views.map((v) => v.name)])).toEqual([
      ['Tasks', [f.grid.name, 'Everything']],
      ['Projects', ['Grid view']],
      ['Budget', ['Grid view']],
    ]);
    const text = JSON.stringify(summary);
    expect(text).not.toContain(personal.id);
    expect(text).not.toContain(form.id);

    // Each view with its own projection: the grid still hides Secret and filters to Done.
    const tasks = await ok<SharedView>(await visit(`/api/shared/${token}/views/${f.grid.id}`));
    expect(tasks.fields.map((x) => x.name)).not.toContain('Secret');
    const page = await ok<{ total: number }>(
      await visit(`/api/shared/${token}/views/${f.grid.id}/records`)
    );
    expect(page.total).toBe(1);
    const everything = await ok<{ total: number }>(
      await visit(`/api/shared/${token}/views/${f.other.id}/records`)
    );
    expect(everything.total).toBe(2);
    const budgetView = summary.tables[2]?.views[0]?.id ?? '';
    const budget = await ok<{ records: SharedRecord[] }>(
      await visit(`/api/shared/${token}/views/${budgetView}/records`)
    );
    expect(JSON.stringify(budget.records)).toContain('Payroll');

    // Personal and form views, another base's views and a view link's other views: 404.
    const elsewhere = await fixture();
    const view = await share(f.grid.id);
    for (const path of [
      `/api/shared/${token}/views/${personal.id}`,
      `/api/shared/${token}/views/${form.id}/records`,
      `/api/shared/${token}/views/${elsewhere.grid.id}`,
      `/api/shared/${token}/views/${elsewhere.grid.id}/records`,
      `/api/shared/${view.token}/views/${f.other.id}`,
      `/api/shared/${view.token}/views/${f.other.id}/records`,
      `/api/shared/${token}/views/not-a-uuid`,
    ]) {
      expect((await visit(path)).status, path).toBe(404);
    }
    // A table in the trash leaves the link.
    await t.db.execute(sql`UPDATE tables SET deleted_at = now() WHERE id = ${f.budget.id}`);
    expect((await visit(`/api/shared/${token}/views/${budgetView}`)).status).toBe(404);
    const after = await ok<{ tables: { name: string }[] }>(await visit(`/api/shared/${token}`));
    expect(after.tables.map((x) => x.name)).toEqual(['Tasks', 'Projects']);

    // Revoked: gone.
    await ok(await send('DELETE', `/api/bases/${f.base.id}/shares/${made.id}`), 204);
    expect((await visit(`/api/shared/${token}`)).status).toBe(404);
    // A view link id isn't a base link of the base, and the reverse.
    expect(
      (await send('PATCH', `/api/bases/${f.base.id}/shares/${view.share.id}`, {})).status
    ).toBe(404);
  });

  it('rate-limits the public API per client', async () => {
    const limited = testApp({ db: t.appDb, env: { SHARE_RATE_LIMIT: '3' } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await limited.app.request(`/api/shared/${'B'.repeat(43)}`)).status);
    }
    expect(statuses).toEqual([404, 404, 404, 429, 429]);
  });
});
