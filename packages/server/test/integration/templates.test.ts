import {
  type Base,
  BUILT_IN_TEMPLATES,
  type FieldMeta,
  findTemplate,
  type InterfaceList,
  type InterfacePageData,
  type TableMeta,
  type Template,
  TemplateSchema,
} from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import { automations } from '../../src/db/index.js';
import { unlimitedEntitlements } from '../../src/edition/oss.js';
import { installTemplate } from '../../src/templates/install.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createUser, createWorkspace } from '../helpers/factories.js';
import { planEdition } from '../helpers/plans.js';

interface ViewMeta {
  id: string;
  name: string;
  type: string;
}
interface RecordMeta {
  id: string;
  fields: Record<string, unknown>;
}

/**
 * Templates: the gallery, installing every built-in template into a working base (fields,
 * links both ways, formulas, lookups, rollups and counts computed, views that query, automations
 * off), the access rules and plan limit, and "Save as template" round-tripping a base.
 */
describe('templates', () => {
  const t = useTestDb();
  const plans = planEdition();
  let app: ReturnType<typeof testApp>['app'];
  let logs: ReturnType<typeof testApp>['logs'];
  let workspaceId: string;
  let ownerId: string;
  let token: string;

  beforeAll(async () => {
    ({ app, logs } = testApp({ db: t.appDb, edition: plans.edition }));
    const ws = await createWorkspace(t.db);
    workspaceId = ws.workspace.id;
    ownerId = ws.owner.id;
    token = await createSession(t.db, ws.owner);
  });

  const json = (method: string, path: string, body?: unknown, as: string | null = token) =>
    app.request(path, {
      method,
      headers: {
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        ...(as ? { cookie: `${SESSION_COOKIE}=${as}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    if (r.status !== status) {
      const errors = logs
        .filter((l) => l['err'])
        .map((l) => JSON.stringify(l['err']).slice(0, 600))
        .slice(-1);
      throw new Error(`${r.status}: ${await r.text()} ${errors.join('\n')}`);
    }
    return (await r.json()) as T;
  }

  /** Every table of the base with its fields, views and records (oldest first). */
  async function read(baseId: string) {
    const { tables } = await ok<{ tables: TableMeta[] }>(
      json('GET', `/api/bases/${baseId}/tables`)
    );
    return Promise.all(
      tables.map(async (table) => {
        const { fields } = await ok<{ fields: FieldMeta[] }>(
          json('GET', `/api/tables/${table.id}`)
        );
        const { views } = await ok<{ views: ViewMeta[] }>(
          json('GET', `/api/tables/${table.id}/views`)
        );
        const { records } = await ok<{ records: RecordMeta[] }>(
          json('GET', `/api/tables/${table.id}/records?limit=1000`)
        );
        return { table, fields, views, records };
      })
    );
  }

  const cell = (r: RecordMeta | undefined, f: FieldMeta | undefined) =>
    f ? r?.fields[f.id] : undefined;

  it('lists the built-in templates and reads one', async () => {
    const list = await ok<{ templates: { slug: string; tables: { records: number }[] }[] }>(
      json('GET', '/api/templates')
    );
    expect(list.templates.map((x) => x.slug)).toEqual(BUILT_IN_TEMPLATES.map((x) => x.slug));
    expect(JSON.stringify(list)).not.toContain('Northwind annual plan');
    const crm = await ok<Template>(json('GET', '/api/templates/crm'));
    expect(TemplateSchema.parse(crm)).toEqual(findTemplate('crm'));
    expect((await json('GET', '/api/templates/nope')).status).toBe(404);
    expect((await json('GET', '/api/templates/Bad_Slug')).status).toBe(404);
    expect((await json('GET', '/api/templates', undefined, null)).status).toBe(401);
  });

  for (const template of BUILT_IN_TEMPLATES) {
    it(`installs ${template.slug} into a base that works`, async () => {
      const base = await ok<Base>(
        json('POST', `/api/workspaces/${workspaceId}/templates`, { slug: template.slug }),
        201
      );
      expect(base).toMatchObject({ name: template.name, workspaceId, role: 'owner' });
      const tables = await read(base.id);
      expect(tables.map((x) => x.table.name)).toEqual(template.tables.map((x) => x.name));
      for (const [i, spec] of template.tables.entries()) {
        const got = tables[i];
        if (!got) throw new Error('missing table');
        expect(got.fields.map((f) => f.name)).toEqual(spec.fields.map((f) => f.name));
        expect(got.fields.find((f) => f.isPrimary)?.name).toBe(
          spec.fields.find((f) => f.primary)?.name
        );
        expect(got.views.map((v) => v.name)).toEqual(spec.views.map((v) => v.name));
        expect(got.records).toHaveLength(spec.records.length);
        // Every formula is valid and computes; every view's query runs.
        for (const f of got.fields.filter((x) => x.type === 'formula')) {
          expect(f.options, `${spec.name}.${f.name}`).toMatchObject({ isValid: true });
          for (const r of got.records) {
            expect(JSON.stringify(cell(r, f) ?? null)).not.toContain('#ERROR');
          }
        }
        for (const v of got.views) {
          const res = await json('POST', `/api/tables/${got.table.id}/records/query`, {
            viewId: v.id,
          });
          expect(res.status, `${spec.name} / ${v.name}`).toBe(200);
        }
        // Cells as given, in order (the primary field's text).
        const primary = got.fields.find((f) => f.isPrimary);
        const specPrimary = spec.fields.find((f) => f.primary);
        expect(got.records.map((r) => cell(r, primary))).toEqual(
          spec.records.map((r) => (specPrimary ? r.cells[specPrimary.id] : undefined))
        );
      }
      const autos = await t.db.select().from(automations).where(eq(automations.baseId, base.id));
      expect(autos).toHaveLength(template.automations.length);
      expect(autos.every((a) => !a.enabled && a.createdBy === ownerId)).toBe(true);
      // Its interfaces, published: every page's records and numbers answer.
      const listed = await ok<InterfaceList>(json('GET', `/api/bases/${base.id}/interfaces`));
      expect(listed.interfaces.map((i) => i.name)).toEqual(template.interfaces.map((i) => i.name));
      for (const [i, spec] of template.interfaces.entries()) {
        const got = listed.interfaces[i];
        expect(got?.pages.map((p) => p.name)).toEqual(spec.pages.map((p) => p.name));
        for (const page of got?.pages ?? []) {
          expect(page.publishedAt, page.name).not.toBeNull();
          expect(page.hasChanges).toBe(false);
          const at = `/api/interfaces/${got?.id}/pages/${page.id}`;
          expect((await json('POST', `${at}/records`, {})).status, page.name).toBe(200);
          const data = await ok<InterfacePageData>(json('POST', `${at}/data`, {}));
          for (const el of Object.values(data.elements)) {
            expect(el.type, `${page.name}: ${JSON.stringify(el)}`).not.toBe('error');
          }
        }
      }
    });
  }

  it('computes links, rollups, counts and formulas of the CRM', async () => {
    const base = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/templates`, { slug: 'crm', name: 'My CRM' }),
      201
    );
    expect(base.name).toBe('My CRM');
    const [deals, companies, contacts] = await read(base.id);
    if (!deals || !companies || !contacts) throw new Error('missing tables');
    const f = (x: typeof deals, name: string) => x.fields.find((y) => y.name === name);
    const northwind = companies.records.find(
      (r) => cell(r, f(companies, 'Name')) === 'Northwind Traders'
    );
    // Two deals of 48,000 and 21,000.
    expect(cell(northwind, f(companies, 'Pipeline value'))).toBe(69000);
    expect(cell(northwind, f(companies, 'Deals'))).toHaveLength(2);
    expect(cell(northwind, f(companies, 'Contacts'))).toEqual([
      expect.objectContaining({ name: 'Maya Chen' }),
    ]);
    const annual = deals.records.find((r) => cell(r, f(deals, 'Deal')) === 'Northwind annual plan');
    expect(cell(annual, f(deals, 'Weighted amount'))).toBe(33600);
    expect(cell(annual, f(deals, 'Company'))).toEqual([
      expect.objectContaining({ id: northwind?.id, name: 'Northwind Traders' }),
    ]);
    const stage = f(deals, 'Stage');
    const choices = (stage?.options as { choices?: { id: string; name: string }[] } | undefined)
      ?.choices;
    const negotiation = choices?.find((c) => c.name === 'Negotiation');
    expect(cell(annual, stage)).toBe(negotiation?.id);
  });

  it('refuses below creator, across tenants, anonymous and past the plan', async () => {
    const editor = await createUser(t.db);
    await addMember(t.db, workspaceId, 'editor', editor);
    const editorToken = await createSession(t.db, editor);
    const path = `/api/workspaces/${workspaceId}/templates`;
    expect((await json('POST', path, { slug: 'crm' }, editorToken)).status).toBe(403);
    const other = await createWorkspace(t.db);
    const otherToken = await createSession(t.db, other.owner);
    expect((await json('POST', path, { slug: 'crm' }, otherToken)).status).toBe(404);
    expect((await json('POST', path, { slug: 'crm' }, null)).status).toBe(401);
    expect((await json('POST', path, { slug: 'nope' })).status).toBe(404);
    expect((await json('POST', path, { slug: 'crm', extra: 1 })).status).toBe(422);

    const small = await createWorkspace(t.db);
    plans.set(small.workspace.id, { limits: { recordsPerBase: 5 } });
    const res = await json(
      'POST',
      `/api/workspaces/${small.workspace.id}/templates`,
      { slug: 'crm' },
      await createSession(t.db, small.owner)
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('saves interfaces with a base as a template, and installs them back (#147)', async () => {
    const base = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/templates`, { slug: 'bug-tracker' }),
      201
    );
    const exported = TemplateSchema.parse(
      await (await json('GET', `/api/bases/${base.id}/template.json`)).json()
    );
    const sample = findTemplate('bug-tracker');
    expect(exported.interfaces.map((i) => [i.name, i.pages.map((p) => p.name)])).toEqual(
      sample?.interfaces.map((i) => [i.name, i.pages.map((p) => p.name)])
    );
    const copy = await inScope(t.appDb, { workspaceId, userId: ownerId }, (tx) =>
      installTemplate({ tx, workspaceId, userId: ownerId }, exported, {
        role: 'owner',
        entitlements: unlimitedEntitlements(),
      })
    );
    const listed = await ok<InterfaceList>(json('GET', `/api/bases/${copy.id}/interfaces`));
    expect(listed.interfaces[0]?.pages.map((p) => p.name)).toEqual(
      sample?.interfaces[0]?.pages.map((p) => p.name)
    );
    const tables = await ok<{ tables: { id: string }[] }>(
      json('GET', `/api/bases/${copy.id}/tables`)
    );
    // The copy's pages name the copy's table, not the original's.
    expect(listed.interfaces[0]?.pages[0]?.published?.tableId).toBe(tables.tables[0]?.id);
  });

  it('saves a base as a template that installs back into the same base', async () => {
    const base = await ok<Base>(
      json('POST', `/api/workspaces/${workspaceId}/templates`, { slug: 'product-roadmap' }),
      201
    );
    const res = await json('GET', `/api/bases/${base.id}/template.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(
      'Product roadmap.openrows-template.json'
    );
    const exported = TemplateSchema.parse(await res.json());
    expect(exported).toMatchObject({ slug: 'product-roadmap', category: 'Custom' });
    const before = await read(base.id);
    expect(exported.tables.map((x) => x.records.length)).toEqual(
      before.map((x) => x.records.length)
    );

    const copy = await inScope(t.appDb, { workspaceId, userId: ownerId }, (tx) =>
      installTemplate({ tx, workspaceId, userId: ownerId }, exported, {
        role: 'owner',
        entitlements: unlimitedEntitlements(),
      })
    );
    const after = await read(copy.id);
    const shape = (x: typeof before) =>
      x.map(({ table, fields, views, records }) => ({
        table: table.name,
        fields: fields.map((f) => [f.name, f.type]),
        views: views.map((v) => [v.name, v.type]),
        // Cells by field name; links by the linked record's name.
        records: records.map((r) =>
          Object.fromEntries(
            fields.map((f) => {
              const v = r.fields[f.id];
              const named = Array.isArray(v)
                ? v.map((i) => (typeof i === 'object' && i && 'name' in i ? i.name : i))
                : v;
              return [f.name, named ?? null];
            })
          )
        ),
      }));
    expect(shape(after)).toEqual(shape(before));

    const editor = await createUser(t.db);
    await addMember(t.db, workspaceId, 'editor', editor);
    const editorToken = await createSession(t.db, editor);
    expect(
      (await json('GET', `/api/bases/${base.id}/template.json`, undefined, editorToken)).status
    ).toBe(403);
  });
});
