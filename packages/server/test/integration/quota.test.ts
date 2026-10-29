import type {
  AutomationRun,
  CreatedShare,
  RecordData,
  TableMeta,
  ViewMeta,
} from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_BASE_ID,
  FIXTURE_TOKEN,
  fakeAirtable,
} from '../../src/airtable/__fixtures__/fake.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { runAutomationJob } from '../../src/automations/run.js';
import { scheduleDueAutomations } from '../../src/automations/subscriber.js';
import { qualified } from '../../src/data/columns.js';
import { automationRunCounts, automations, recordRevisions, tables } from '../../src/db/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createReadyAttachment,
  createSession,
  createToken,
  createWorkspace,
} from '../helpers/factories.js';
import { MemoryObjectStore } from '../helpers/object-store.js';
import { planEdition } from '../helpers/plans.js';

/**
 * Plan enforcement, Airtable's "read and edit, no new data": per limit, new data past it
 * is refused (problem type `quota-exceeded`, naming the limit) while everything already there
 * stays readable and editable, nothing is deleted, and an upgrade lifts the block at once.
 */
describe('plan limits', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  const plans = planEdition();
  let app: ReturnType<typeof testApp>;

  beforeAll(() => {
    app = testApp({ db: t.appDb, objectStore: new MemoryObjectStore(), edition: plans.edition });
  });

  interface Who {
    cookie?: string;
    bearer?: string;
  }
  const request = (method: string, path: string, who: Who, body?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { origin: app.config.appUrl };
    if (who.cookie) headers['cookie'] = `${SESSION_COOKIE}=${who.cookie}`;
    if (who.bearer) headers['authorization'] = `Bearer ${who.bearer}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return Promise.resolve(
      app.app.request(path, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    );
  };
  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
    return (status === 204 ? null : await r.json()) as T;
  }
  /** A refusal of new data: 403 (or `status`), problem type quota-exceeded, the limit named. */
  async function refused(res: Response | Promise<Response>, limit: string, status = 403) {
    const r = await res;
    const body = (await r.json()) as Record<string, unknown>;
    expect(r.status, JSON.stringify(body)).toBe(status);
    expect(body).toMatchObject({ code: 'QUOTA_EXCEEDED', limit });
    expect(String(body['type'])).toMatch(/quota-exceeded$/);
    return body;
  }
  async function needsFeature(res: Response | Promise<Response>, feature: string) {
    const r = await res;
    const body = (await r.json()) as Record<string, unknown>;
    expect(r.status, JSON.stringify(body)).toBe(403);
    expect(body).toMatchObject({ code: 'PLAN_FEATURE_REQUIRED', feature });
  }

  /** A workspace of its own (its own plan), its owner signed in, a base and a table. */
  async function tenant() {
    const { owner, workspace } = await createWorkspace(t.db);
    const who: Who = { cookie: await createSession(t.db, owner) };
    const base = await ok<{ id: string }>(
      request('POST', `/api/workspaces/${workspace.id}/bases`, who, { name: 'Base' }),
      201
    );
    const table = await ok<TableMeta>(
      request('POST', `/api/bases/${base.id}/tables`, who, { name: 'Tasks' }),
      201
    );
    const primary = table.fields.find((f) => f.isPrimary)?.id ?? '';
    return { owner, workspaceId: workspace.id, who, base, table, primary };
  }
  type Tenant = Awaited<ReturnType<typeof tenant>>;

  const create = (w: Tenant, n: number, tableId = w.table.id) =>
    request('POST', `/api/tables/${tableId}/records`, w.who, {
      records: Array.from({ length: n }, (_, i) => ({ fields: { [w.primary]: `R${i}` } })),
    });
  const createIds = async (w: Tenant, n: number) =>
    (await ok<{ records: RecordData[] }>(create(w, n), 201)).records.map((r) => r.id);
  const live = async (tableId: string) => {
    const [row] = await t.db.select().from(tables).where(eq(tables.id, tableId));
    if (!row) throw new Error('no table');
    const { rows } = await t.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${qualified(row)} WHERE deleted_at IS NULL`
    );
    return rows[0]?.n ?? -1;
  };

  describe('records per base', () => {
    it('refuses new records past the limit, keeps editing, deleting and reading them', async () => {
      const w = await tenant();
      plans.set(w.workspaceId, { limits: { recordsPerBase: 3 } });
      const ids = await createIds(w, 2);
      // A batch that doesn't fit is refused whole.
      const body = await refused(create(w, 2), 'recordsPerBase');
      expect(body).toMatchObject({ used: 2, max: 3, baseId: w.base.id });
      expect(await live(w.table.id)).toBe(2);
      await createIds(w, 1);
      await refused(create(w, 1), 'recordsPerBase');

      // Over the limit after a downgrade: still readable and editable, nothing hidden.
      plans.set(w.workspaceId, { limits: { recordsPerBase: 1 } });
      const list = await ok<{ records: RecordData[] }>(
        request('GET', `/api/tables/${w.table.id}/records`, w.who)
      );
      expect(list.records).toHaveLength(3);
      await ok(
        request('PATCH', `/api/tables/${w.table.id}/records`, w.who, {
          records: [{ id: ids[0], fields: { [w.primary]: 'Edited' } }],
        })
      );
      await refused(create(w, 1), 'recordsPerBase');

      // Trash and restore: deleting is fine, bringing back past the limit isn't.
      await ok(
        request('POST', `/api/tables/${w.table.id}/records/delete`, w.who, { recordIds: [ids[1]] })
      );
      await refused(
        request('POST', `/api/tables/${w.table.id}/records/restore`, w.who, {
          recordIds: [ids[1]],
        }),
        'recordsPerBase'
      );
      expect(await live(w.table.id)).toBe(2);

      // The upgrade lifts it at once.
      plans.set(w.workspaceId, {});
      await ok(
        request('POST', `/api/tables/${w.table.id}/records/restore`, w.who, {
          recordIds: [ids[1]],
        })
      );
      await createIds(w, 1);
      expect(await live(w.table.id)).toBe(4);
    });

    it('counts every table of the base and checks duplicates, table restores and imports', async () => {
      const w = await tenant();
      await createIds(w, 3);
      plans.set(w.workspaceId, { limits: { recordsPerBase: 4 } });
      // A table copy with its records doesn't fit; without them it does.
      await refused(
        request('POST', `/api/tables/${w.table.id}/duplicate`, w.who, { includeRecords: true }),
        'recordsPerBase'
      );
      const copy = await ok<TableMeta>(
        request('POST', `/api/tables/${w.table.id}/duplicate`, w.who, { includeRecords: false }),
        201
      );
      // Another table of the same base shares the base's limit.
      const other = copy.fields.find((f) => f.isPrimary)?.id ?? '';
      await ok(
        request('POST', `/api/tables/${copy.id}/records`, w.who, {
          records: [{ fields: { [other]: 'Fits' } }],
        }),
        201
      );
      await refused(
        request('POST', `/api/tables/${copy.id}/records`, w.who, {
          records: [{ fields: { [other]: 'No room' } }],
        }),
        'recordsPerBase'
      );

      // A trashed table's records come back with it only if they fit.
      await ok(request('DELETE', `/api/tables/${copy.id}`, w.who), 204);
      await createIds(w, 1);
      await refused(
        request('POST', `/api/bases/${w.base.id}/trash/tables/${copy.id}/restore`, w.who),
        'recordsPerBase'
      );

      // A CSV import that can't fit is refused before it starts.
      await refused(
        request('POST', `/api/tables/${w.table.id}/imports`, w.who, {
          csv: 'Name\nA\n',
          columns: [{ index: 0, fieldId: w.primary }],
        }),
        'recordsPerBase'
      );
      expect(await live(w.table.id)).toBe(4);
    });

    it('stops a running CSV import at the limit, keeping the batches before it', async () => {
      const w = await tenant();
      plans.set(w.workspaceId, { limits: { recordsPerBase: 1600 } });
      // Batches of IMPORT_BATCH (1000): the first fits, the second doesn't.
      const csv = `Name\n${Array.from({ length: 1500 }, (_, i) => `Row ${i}`).join('\n')}\n`;
      const job = await ok<{ id: string }>(
        request('POST', `/api/tables/${w.table.id}/imports`, w.who, {
          csv,
          columns: [{ index: 0, fieldId: w.primary }],
        }),
        201
      );
      // Someone else fills the base while the import waits for the worker.
      await createIds(w, 100);
      await createIds(w, 100);
      await app.runJob(job.id, { lastAttempt: true });
      const done = await ok<{ status: string; error: string | null }>(
        request('GET', `/api/tables/${w.table.id}/imports/${job.id}`, w.who)
      );
      expect(done.status).toBe('failed');
      expect(done.error).toMatch(/records/);
      expect(await live(w.table.id)).toBe(1200);
    });

    it('refuses a snapshot restore too big for a base, leaving no partial base', async () => {
      const w = await tenant();
      await createIds(w, 3);
      const snap = await ok<{ id: string }>(
        request('POST', `/api/bases/${w.base.id}/snapshots`, w.who),
        201
      );
      plans.set(w.workspaceId, { limits: { recordsPerBase: 2 } });
      const job = await ok<{ id: string }>(
        request('POST', `/api/bases/${w.base.id}/snapshots/${snap.id}/restore`, w.who, {}),
        201
      );
      await app.runJob(job.id, { lastAttempt: true });
      const done = await ok<{ status: string; error: string | null; base: unknown }>(
        request('GET', `/api/bases/${w.base.id}/snapshot-restores/${job.id}`, w.who)
      );
      expect(done).toMatchObject({ status: 'failed', base: null });
      expect(done.error).toMatch(/records/);
      const { rows } = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM bases WHERE workspace_id = ${w.workspaceId}::uuid`
      );
      expect(rows[0]?.n).toBe(1);
      // The source base is untouched (over its limit now, still all there).
      expect(await live(w.table.id)).toBe(3);
    });

    it('stops an Airtable import at the limit, keeping what it imported', async () => {
      const w = await tenant();
      const importer = testApp({
        db: t.appDb,
        objectStore: new MemoryObjectStore(),
        edition: plans.edition,
        airtable: { http: fakeAirtable().http, sleep: async () => {} },
      });
      plans.set(w.workspaceId, { limits: { recordsPerBase: 40 } });
      const res = await importer.app.request(`/api/workspaces/${w.workspaceId}/airtable/imports`, {
        method: 'POST',
        headers: {
          origin: importer.config.appUrl,
          cookie: `${SESSION_COOKIE}=${w.who.cookie}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token: FIXTURE_TOKEN, baseIds: [FIXTURE_BASE_ID] }),
      });
      const { imports } = await ok<{ imports: { id: string; baseId: string | null }[] }>(res, 201);
      const job = imports[0];
      if (!job) throw new Error('no import');
      await importer.runJob(job.id, { lastAttempt: true });
      const [row] = (
        await t.db.execute<{ status: string; error: string | null }>(
          sql`SELECT status, error FROM jobs WHERE id = ${job.id}::uuid`
        )
      ).rows;
      expect(row?.status).toBe('failed');
      expect(row?.error).toMatch(/records/);
      const { rows } = await t.db.execute<{ n: string }>(
        sql`SELECT coalesce(sum(c.records), 0) AS n FROM table_record_counts c
              JOIN bases b ON b.id = c.base_id
             WHERE b.workspace_id = ${w.workspaceId}::uuid AND b.id <> ${w.base.id}::uuid`
      );
      const imported = Number(rows[0]?.n);
      expect(imported).toBeGreaterThan(0);
      expect(imported).toBeLessThanOrEqual(40);
    });

    it('refuses REST API v1 creates in its error shape, still updating', async () => {
      const w = await tenant();
      const [id] = await createIds(w, 1);
      plans.set(w.workspaceId, { limits: { recordsPerBase: 1 } });
      const { token } = await createToken(t.db, w.owner, { workspaceIds: [w.workspaceId] });
      const bearer = { bearer: token };
      const res = await request('POST', `/api/v1/${w.base.id}/${w.table.id}`, bearer, {
        records: [{ fields: { Name: 'New' } }],
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { type: 'QUOTA_EXCEEDED', code: 'QUOTA_EXCEEDED', limit: 'recordsPerBase' },
      });
      await ok(
        request('PATCH', `/api/v1/${w.base.id}/${w.table.id}`, bearer, {
          records: [{ id, fields: { Name: 'Renamed' } }],
        })
      );
    });

    it('refuses a public form submission without saying how full the workspace is', async () => {
      const w = await tenant();
      const form = await ok<ViewMeta>(
        request('POST', `/api/tables/${w.table.id}/views`, w.who, { name: 'Intake', type: 'form' }),
        201
      );
      const { token } = await ok<CreatedShare>(
        request('POST', `/api/views/${form.id}/shares`, w.who, {}),
        201
      );
      const submit = () =>
        request(
          'POST',
          `/api/forms/${token}/submissions`,
          {},
          {
            submissionId: uuidv7(),
            fields: { [w.primary]: 'Hello' },
          }
        );
      await ok(submit(), 201);
      plans.set(w.workspaceId, { limits: { recordsPerBase: 1 } });
      const body = await refused(submit(), 'recordsPerBase');
      expect(body).not.toHaveProperty('used');
      expect(body).not.toHaveProperty('baseId');
      expect(await live(w.table.id)).toBe(1);
    });
  });

  it('refuses uploads past the attachment storage; existing files stay downloadable', async () => {
    const w = await tenant();
    const files = await ok<TableMeta['fields'][number]>(
      request('POST', `/api/tables/${w.table.id}/fields`, w.who, {
        name: 'Files',
        type: 'attachment',
      }),
      201
    );
    const at = {
      workspaceId: w.workspaceId,
      baseId: w.base.id,
      tableId: w.table.id,
      fieldId: files.id,
    };
    const existing = await createReadyAttachment(t.db, at, {
      filename: 'a.txt',
      type: 'text/plain',
      size: 900,
    });
    plans.set(w.workspaceId, { limits: { attachmentBytesPerWorkspace: 1000 } });
    const upload = (size: number) =>
      request('POST', `/api/tables/${w.table.id}/attachments`, w.who, {
        fieldId: files.id,
        filename: 'b.txt',
        type: 'text/plain',
        size,
      });
    const body = await refused(upload(200), 'attachmentBytesPerWorkspace');
    expect(body).toMatchObject({ used: 900, max: 1000 });
    await ok(upload(100), 201);
    const download = await request(
      'GET',
      `/api/tables/${w.table.id}/attachments/${existing.id}`,
      w.who
    );
    expect(download.status).toBeLessThan(400);
  });

  it('records automation runs past the monthly quota as skipped, then runs again after an upgrade', async () => {
    const w = await tenant();
    const autos = `/api/bases/${w.base.id}/automations`;
    const a = await ok<{ id: string }>(
      request('POST', autos, w.who, {
        name: 'Tick',
        enabled: true,
        trigger: {
          type: 'scheduled',
          schedule: {
            kind: 'interval',
            every: 5,
            unit: 'minutes',
            startAt: '2026-01-01T00:00',
            timeZone: 'UTC',
          },
        },
        actions: [{ type: 'createRecord', tableId: w.table.id, fields: { [w.primary]: 'Tick' } }],
      }),
      201
    );
    // This month's runs are used up.
    await t.db.insert(automationRunCounts).values({
      workspaceId: w.workspaceId,
      month: sql`date_trunc('month', now())::date`,
      runs: 5,
    });
    plans.set(w.workspaceId, { limits: { automationRunsPerMonth: 5 } });
    const runOnce = async () => {
      const due = new Date(Date.now() - Math.floor(Math.random() * 1000 + 1) * 60_000);
      await t.db.update(automations).set({ nextRunAt: due }).where(eq(automations.id, a.id));
      const jobs: { data?: unknown }[] = [];
      await scheduleDueAutomations(t.appDb, async (_q, batch) => void jobs.push(...batch));
      const job = jobs.find((j) => (j.data as { subscriberId?: string }).subscriberId === a.id);
      return runAutomationJob(
        { db: t.appDb, logger, entitlements: plans.edition.entitlements },
        job?.data
      );
    };
    expect(await runOnce()).toMatchObject({ status: 'skipped' });
    expect(await live(w.table.id)).toBe(0);
    const { runs } = await ok<{ runs: AutomationRun[] }>(
      request('GET', `${autos}/${a.id}/runs`, w.who)
    );
    expect(runs[0]).toMatchObject({ status: 'skipped', skipReason: 'quota' });
    expect(runs[0]?.error).toMatch(/automation runs per month/);
    // Skipped runs aren't counted.
    const [count] = await t.db
      .select({ runs: automationRunCounts.runs })
      .from(automationRunCounts)
      .where(eq(automationRunCounts.workspaceId, w.workspaceId));
    expect(count?.runs).toBe(5);
    // A test from the builder isn't counted, so it still runs.
    await ok(request('POST', `${autos}/${a.id}/test`, w.who, {}));

    plans.set(w.workspaceId, { limits: { automationRunsPerMonth: 100 } });
    expect(await runOnce()).toMatchObject({ status: 'succeeded' });
    expect(await live(w.table.id)).toBe(2);
  });

  it('answers API calls past the monthly quota with 429 and the reset time; the app keeps working', async () => {
    const w = await tenant();
    plans.set(w.workspaceId, { limits: { apiCallsPerMonth: 2 } });
    const { token } = await createToken(t.db, w.owner, { workspaceIds: [w.workspaceId] });
    const list = () => request('GET', `/api/v1/${w.base.id}/${w.table.id}`, { bearer: token });
    await ok(list());
    await ok(list());
    const res = await list();
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(res.status).toBe(429);
    expect(body.error).toMatchObject({ code: 'QUOTA_EXCEEDED', limit: 'apiCallsPerMonth' });
    const resetsAt = new Date(String(body.error['resetsAt']));
    expect(resetsAt.getUTCDate()).toBe(1);
    expect(resetsAt.getTime()).toBeGreaterThan(Date.now());
    // Refused calls aren't counted; the app's own routes aren't API calls.
    const { rows } = await t.db.execute<{ calls: string }>(
      sql`SELECT calls FROM api_call_counts WHERE workspace_id = ${w.workspaceId}::uuid`
    );
    expect(Number(rows[0]?.calls)).toBe(2);
    await ok(request('GET', `/api/tables/${w.table.id}/records`, w.who));
    plans.set(w.workspaceId, { limits: { apiCallsPerMonth: 3 } });
    await ok(list());
  });

  it('refuses editor seats past the limit; commenters and read-only people are free', async () => {
    const w = await tenant();
    plans.set(w.workspaceId, { limits: { editorsPerWorkspace: 2 } });
    const invite = (email: string, role: string) =>
      request('POST', `/api/workspaces/${w.workspaceId}/invitations`, w.who, { email, role });
    // The owner holds one seat; a pending editor invitation holds the second.
    await ok(invite('first@example.test', 'editor'), 201);
    const body = await refused(invite('second@example.test', 'creator'), 'editorsPerWorkspace');
    expect(body).toMatchObject({ used: 2, max: 2 });
    await refused(
      request('POST', `/api/bases/${w.base.id}/invitations`, w.who, {
        email: 'third@example.test',
        role: 'editor',
      }),
      'editorsPerWorkspace'
    );
    // Re-sending the same invitation takes no new seat; viewers never do.
    await ok(invite('first@example.test', 'editor'), 201);
    await ok(invite('second@example.test', 'commenter'), 201);
    await ok(invite('third@example.test', 'read_only'), 201);

    const viewer = await addMember(t.db, w.workspaceId, 'commenter');
    await refused(
      request('PATCH', `/api/workspaces/${w.workspaceId}/members/${viewer.id}`, w.who, {
        role: 'editor',
      }),
      'editorsPerWorkspace'
    );
    await refused(
      request('PATCH', `/api/bases/${w.base.id}/collaborators/${viewer.id}`, w.who, {
        role: 'editor',
      }),
      'editorsPerWorkspace'
    );
    // An existing editor keeps their seat and can change between seat roles.
    plans.set(w.workspaceId, { limits: { editorsPerWorkspace: 1 } });
    const editor = await addMember(t.db, w.workspaceId, 'editor');
    await ok(
      request('PATCH', `/api/workspaces/${w.workspaceId}/members/${editor.id}`, w.who, {
        role: 'creator',
      })
    );
    plans.set(w.workspaceId, {});
    await ok(
      request('PATCH', `/api/workspaces/${w.workspaceId}/members/${viewer.id}`, w.who, {
        role: 'editor',
      })
    );
  });

  describe('plan features', () => {
    it('keeps personal and locked views after a downgrade; new ones need the plan', async () => {
      const w = await tenant();
      const views = `/api/tables/${w.table.id}/views`;
      const mine = await ok<ViewMeta>(
        request('POST', views, w.who, { name: 'Mine', type: 'grid', personal: true }),
        201
      );
      const shared = await ok<ViewMeta>(
        request('POST', views, w.who, { name: 'Team', type: 'grid' }),
        201
      );
      await ok(request('PATCH', `/api/views/${shared.id}`, w.who, { locked: true }));

      plans.set(w.workspaceId, { features: { personalViews: false, lockedViews: false } });
      await needsFeature(
        request('POST', views, w.who, { name: 'Mine 2', type: 'grid', personal: true }),
        'personalViews'
      );
      await needsFeature(
        request('POST', `/api/views/${mine.id}/duplicate`, w.who, {}),
        'personalViews'
      );
      const plain = await ok<ViewMeta>(
        request('POST', views, w.who, { name: 'Plain', type: 'grid' }),
        201
      );
      await needsFeature(
        request('PATCH', `/api/views/${plain.id}`, w.who, { personal: true }),
        'personalViews'
      );
      await needsFeature(
        request('PATCH', `/api/views/${plain.id}`, w.who, { locked: true }),
        'lockedViews'
      );
      // What exists keeps working: the personal view is still the owner's, still editable.
      await ok(request('PATCH', `/api/views/${mine.id}`, w.who, { name: 'Still mine' }));
      const locked = await ok<ViewMeta>(request('GET', `/api/views/${shared.id}`, w.who));
      expect(locked.locked).toBe(true);
      // Undoing a feature never needs it.
      await ok(request('PATCH', `/api/views/${shared.id}`, w.who, { locked: false }));
      await ok(request('PATCH', `/api/views/${mine.id}`, w.who, { personal: false }));
    });

    it('keeps edit permissions after a downgrade; new restrictions need the plan', async () => {
      const w = await tenant();
      const field = w.primary;
      await ok(
        request('PATCH', `/api/tables/${w.table.id}`, w.who, {
          permissions: { deleteRecords: { level: 'creators' } },
        })
      );
      plans.set(w.workspaceId, { features: { editPermissions: false } });
      await needsFeature(
        request('PATCH', `/api/tables/${w.table.id}`, w.who, {
          permissions: { addRecords: { level: 'creators' } },
        }),
        'editPermissions'
      );
      await needsFeature(
        request('PATCH', `/api/fields/${field}`, w.who, {
          permissions: { edit: { level: 'nobody' } },
        }),
        'editPermissions'
      );
      // The existing restriction still applies to an editor.
      const editor = await addMember(t.db, w.workspaceId, 'editor');
      const asEditor = { cookie: await createSession(t.db, editor) };
      const [id] = await createIds(w, 1);
      const del = await request('POST', `/api/tables/${w.table.id}/records/delete`, asEditor, {
        recordIds: [id],
      });
      expect(del.status).toBe(403);
      // Sending it again unchanged, or removing it, is fine.
      await ok(
        request('PATCH', `/api/tables/${w.table.id}`, w.who, {
          permissions: { deleteRecords: { level: 'creators' } },
        })
      );
      await ok(
        request('PATCH', `/api/tables/${w.table.id}`, w.who, {
          permissions: { deleteRecords: { level: 'editors' } },
        })
      );
    });

    it("needs the plan to remove a form's branding, never to show it again", async () => {
      const w = await tenant();
      const form = await ok<ViewMeta>(
        request('POST', `/api/tables/${w.table.id}/views`, w.who, { name: 'Intake', type: 'form' }),
        201
      );
      plans.set(w.workspaceId, { features: { removeBranding: false } });
      await needsFeature(
        request('PATCH', `/api/views/${form.id}`, w.who, { form: { showBranding: false } }),
        'removeBranding'
      );
      plans.set(w.workspaceId, {});
      await ok(request('PATCH', `/api/views/${form.id}`, w.who, { form: { showBranding: false } }));
      plans.set(w.workspaceId, { features: { removeBranding: false } });
      // Already unbranded: other changes to the form still save, and branding can come back.
      await ok(
        request('PATCH', `/api/views/${form.id}`, w.who, {
          form: { showBranding: false, title: 'Renamed' },
        })
      );
      await ok(request('PATCH', `/api/views/${form.id}`, w.who, { form: { showBranding: true } }));
    });
  });

  it('hides revisions older than the history window without deleting them', async () => {
    const w = await tenant();
    const [id] = await createIds(w, 1);
    /** Makes the record's revisions so far 40 days old (so the next edit isn't coalesced). */
    const age = () =>
      t.db
        .update(recordRevisions)
        .set({
          createdAt: sql`now() - interval '40 days'`,
          updatedAt: sql`now() - interval '40 days'`,
        })
        .where(eq(recordRevisions.recordId, id ?? ''));
    const edit = (value: string) =>
      ok(
        request('PATCH', `/api/tables/${w.table.id}/records`, w.who, {
          records: [{ id, fields: { [w.primary]: value } }],
        })
      );
    await age();
    await edit('One');
    await age();
    await edit('Two');
    const path = `/api/tables/${w.table.id}/records/${id}/revisions`;
    const all = await ok<{ revisions: { id: string }[] }>(request('GET', path, w.who));
    const total = all.revisions.length;
    expect(total).toBeGreaterThanOrEqual(3);

    plans.set(w.workspaceId, { limits: { revisionHistoryDays: 14 } });
    const windowed = await ok<{ revisions: { id: string; at: string }[] }>(
      request('GET', path, w.who)
    );
    expect(windowed.revisions.length).toBeLessThan(total);
    for (const r of windowed.revisions) {
      expect(Date.now() - new Date(r.at).getTime()).toBeLessThan(14 * 86_400_000);
    }
    const old = all.revisions.find((r) => !windowed.revisions.some((x) => x.id === r.id));
    const restore = await request('POST', `${path}/${old?.id}/restore`, w.who, {});
    expect(restore.status).toBe(404);
    // Still stored: an upgrade brings them back.
    const [stored] = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(recordRevisions)
      .where(eq(recordRevisions.recordId, id ?? ''));
    expect(stored?.n).toBe(total);
    plans.set(w.workspaceId, {});
    const back = await ok<{ revisions: unknown[] }>(request('GET', path, w.who));
    expect(back.revisions).toHaveLength(total);
  });
});
