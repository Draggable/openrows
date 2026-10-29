import type {
  BaseUsageWarnings,
  CreatedShare,
  PublicForm,
  TableMeta,
  ViewMeta,
  WorkspaceUsage,
} from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { memoryTransport } from '../../src/email/transport.js';
import { createLogger } from '../../src/lib/logger.js';
import { checkUsageWarnings, runUsageWarnings } from '../../src/usage/warnings.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createUser, createWorkspace } from '../helpers/factories.js';
import { planEdition } from '../helpers/plans.js';

/**
 * Plan-limit warnings: the base banner's warnings at 80% and 100%, the owners' emails
 * (once per limit, level and month, through the worker's check) and public forms that stop
 * accepting responses at the records limit and tell the owners.
 */
describe('plan limit warnings', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  const plans = planEdition();
  let app: ReturnType<typeof testApp>;

  beforeAll(() => {
    app = testApp({ db: t.appDb, edition: plans.edition });
  });

  const request = (method: string, path: string, cookie?: string, body?: unknown) => {
    const headers: Record<string, string> = { origin: app.config.appUrl };
    if (cookie) headers['cookie'] = `${SESSION_COOKIE}=${cookie}`;
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
    return (await r.json()) as T;
  }

  async function tenant(bases = ['Roadmap']) {
    const { owner, workspace } = await createWorkspace(t.db, { name: 'Acme' });
    const cookie = await createSession(t.db, owner);
    const made: { id: string; table: TableMeta }[] = [];
    for (const name of bases) {
      const base = await ok<{ id: string }>(
        request('POST', `/api/workspaces/${workspace.id}/bases`, cookie, { name }),
        201
      );
      const table = await ok<TableMeta>(
        request('POST', `/api/bases/${base.id}/tables`, cookie, { name: 'Tasks' }),
        201
      );
      made.push({ id: base.id, table });
    }
    return { owner, workspaceId: workspace.id, cookie, bases: made };
  }
  type Tenant = Awaited<ReturnType<typeof tenant>>;
  const add = (w: Tenant, n: number, base = 0) =>
    ok(
      request('POST', `/api/tables/${w.bases[base]?.table.id}/records`, w.cookie, {
        records: Array.from({ length: n }, () => ({ fields: {} })),
      }),
      201
    );
  const banner = (w: Tenant, base = 0) =>
    ok<BaseUsageWarnings>(
      request('GET', `/api/bases/${w.bases[base]?.id}/usage-warnings`, w.cookie)
    );

  describe('the base banner', () => {
    it('warns at 80% and 100% of the base records, never about other bases', async () => {
      const w = await tenant(['Roadmap', 'CRM']);
      plans.set(w.workspaceId, { limits: { recordsPerBase: 5 } });
      await add(w, 3);
      await add(w, 5, 1);
      expect((await banner(w)).warnings).toEqual([]);
      await add(w, 1);
      const near = await banner(w);
      expect(near).toMatchObject({ workspaceId: w.workspaceId, upgradeUrl: null });
      expect(near.warnings).toEqual([
        {
          metric: 'recordsPerBase',
          level: 'near',
          used: 4,
          limit: 5,
          base: { id: w.bases[0]?.id, name: 'Roadmap' },
          resetsOn: null,
        },
      ]);
      await add(w, 1);
      expect((await banner(w)).warnings).toMatchObject([
        { metric: 'recordsPerBase', level: 'full' },
      ]);
      // The other base is full too, and says so on its own banner only.
      expect((await banner(w, 1)).warnings).toMatchObject([
        { metric: 'recordsPerBase', level: 'full', base: { name: 'CRM' } },
      ]);
    });

    it("includes the workspace's monthly limits with their reset day", async () => {
      const w = await tenant();
      plans.set(w.workspaceId, { limits: { apiCallsPerMonth: 100, automationRunsPerMonth: 10 } });
      await t.db.execute(sql`
        INSERT INTO api_call_counts (workspace_id, month, calls)
        VALUES (${w.workspaceId}::uuid, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 100)`);
      await t.db.execute(sql`
        INSERT INTO automation_run_counts (workspace_id, month, runs)
        VALUES (${w.workspaceId}::uuid, date_trunc('month', now())::date, 8)`);
      const { warnings } = await banner(w);
      const usage = await ok<WorkspaceUsage>(
        request('GET', `/api/workspaces/${w.workspaceId}/usage`, w.cookie)
      );
      expect(warnings).toEqual([
        expect.objectContaining({
          metric: 'apiCallsPerMonth',
          level: 'full',
          resetsOn: usage.period.end,
        }),
        expect.objectContaining({ metric: 'automationRunsPerMonth', level: 'near', used: 8 }),
      ]);
      expect(usage.upgradeUrl).toBeNull();
    });

    it('has nothing to say without limits (the OSS edition)', async () => {
      const w = await tenant();
      await add(w, 3);
      expect(await banner(w)).toMatchObject({ warnings: [], plan: { id: 'test' } });
    });
  });

  describe("the owners' emails", () => {
    const deps = () => {
      const email = memoryTransport();
      return {
        email,
        deps: {
          db: t.appDb,
          entitlements: plans.edition.entitlements,
          email,
          appUrl: app.config.appUrl,
          logger,
        },
      };
    };

    it('emails each verified owner once per limit, level and month', async () => {
      const w = await tenant();
      const coOwner = await addMember(t.db, w.workspaceId, 'owner');
      await addMember(
        t.db,
        w.workspaceId,
        'owner',
        await createUser(t.db, { emailVerified: false })
      );
      await addMember(t.db, w.workspaceId, 'editor');
      plans.set(w.workspaceId, { limits: { recordsPerBase: 5 } });
      const { email, deps: d } = deps();

      await add(w, 3);
      expect(await checkUsageWarnings(d, w.workspaceId)).toBe(0);
      await add(w, 1);
      expect(await checkUsageWarnings(d, w.workspaceId)).toBe(2);
      expect(email.sent.map((m) => m.to).sort()).toEqual([w.owner.email, coOwner.email].sort());
      expect(email.sent[0]?.subject).toBe('Acme is close to a limit of its test plan');
      expect(email.sent[0]?.text).toContain(
        'Roadmap has 4 of the 5 records its plan allows (80%).'
      );
      expect(email.sent[0]?.text).toContain(`/w/${w.workspaceId}/usage`);
      // Again: nothing new.
      expect(await checkUsageWarnings(d, w.workspaceId)).toBe(0);

      await add(w, 1);
      expect(await checkUsageWarnings(d, w.workspaceId)).toBe(2);
      expect(email.sent[2]?.subject).toBe('Acme reached a limit of its test plan');
      expect(email.sent[2]?.text).toContain("its forms aren't accepting responses");
      expect(await checkUsageWarnings(d, w.workspaceId)).toBe(0);

      // Next month the standing limit is told again, once.
      const next = new Date();
      next.setUTCMonth(next.getUTCMonth() + 1, 2);
      expect(await checkUsageWarnings(d, w.workspaceId, next)).toBe(2);
      expect(await checkUsageWarnings(d, w.workspaceId, next)).toBe(0);
      expect(email.sent).toHaveLength(6);
    });

    it('a limit first seen full is told once, without an 80% email after it', async () => {
      const w = await tenant();
      plans.set(w.workspaceId, { limits: { recordsPerBase: 4 } });
      const { email, deps: d } = deps();
      await add(w, 4);
      expect(await checkUsageWarnings(d, w.workspaceId)).toBe(1);
      // A bigger limit: now at 80%, which counts as already told this month.
      plans.set(w.workspaceId, { limits: { recordsPerBase: 5 } });
      expect(await checkUsageWarnings(d, w.workspaceId)).toBe(0);
      expect(email.sent).toHaveLength(1);
    });

    it('the hourly run checks every workspace with limits, in its own scope', async () => {
      const a = await tenant();
      const b = await tenant();
      plans.set(a.workspaceId, { limits: { recordsPerBase: 1 } });
      plans.set(b.workspaceId, { limits: { recordsPerBase: 10 } });
      await add(a, 1);
      await add(b, 1);
      const { email, deps: d } = deps();
      const result = await runUsageWarnings(d, new Date(), 2);
      expect(result.workspaces).toBeGreaterThanOrEqual(2);
      expect(email.sent.map((m) => m.to)).toContain(a.owner.email);
      expect(email.sent.map((m) => m.to)).not.toContain(b.owner.email);
    });
  });

  describe('public forms at the records limit', () => {
    it("say they aren't accepting responses and ask the worker to tell the owners", async () => {
      const w = await tenant();
      const tableId = w.bases[0]?.table.id;
      const primary = w.bases[0]?.table.fields.find((f) => f.isPrimary)?.id ?? '';
      const form = await ok<ViewMeta>(
        request('POST', `/api/tables/${tableId}/views`, w.cookie, { name: 'Intake', type: 'form' }),
        201
      );
      const { token } = await ok<CreatedShare>(
        request('POST', `/api/views/${form.id}/shares`, w.cookie, {}),
        201
      );
      const checks = async () => {
        const { rows } = await t.db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pgboss.job
           WHERE name = 'usage.check' AND data->>'workspaceId' = ${w.workspaceId}`);
        return rows[0]?.n ?? 0;
      };
      const submit = () =>
        request('POST', `/api/forms/${token}/submissions`, undefined, {
          submissionId: uuidv7(),
          fields: { [primary]: 'Hello' },
        });

      plans.set(w.workspaceId, { limits: { recordsPerBase: 1 } });
      expect((await ok<PublicForm>(request('GET', `/api/forms/${token}`))).accepting).toBe(true);
      await ok(submit(), 201);
      expect(await checks()).toBe(0);

      expect((await ok<PublicForm>(request('GET', `/api/forms/${token}`))).accepting).toBe(false);
      expect(await checks()).toBe(1);
      const refused = await submit();
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: 'QUOTA_EXCEEDED',
        detail: "This form isn't accepting responses right now.",
      });
      // One queued check per workspace.
      expect(await checks()).toBe(1);
    });
  });
});
