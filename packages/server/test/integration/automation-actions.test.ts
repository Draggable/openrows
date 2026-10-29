import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { REDACTED } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import type { JobInsert } from 'pg-boss';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import type { OutboundDeps } from '../../src/automations/outbound.js';
import { runAutomationJob } from '../../src/automations/run.js';
import { automationSubscriber } from '../../src/automations/subscriber.js';
import { qualified } from '../../src/data/columns.js';
import {
  automationEmailCounts,
  automationRuns,
  automations,
  type bases,
  fields,
  tables,
  type users,
  workspaceMembers,
} from '../../src/db/index.js';
import { unlimitedEntitlements } from '../../src/edition/oss.js';
import { memoryTransport } from '../../src/email/transport.js';
import { createField } from '../../src/fields/service.js';
import { type RelayJobData, relayOutbox } from '../../src/jobs/relay.js';
import { createLogger } from '../../src/lib/logger.js';
import { REFUSED_URLS } from '../../src/lib/safe-fetch/__fixtures__/refused-urls.js';
import { createSafeFetch, outboundPolicy } from '../../src/lib/safe-fetch/index.js';
import { MemoryRateLimiter } from '../../src/ratelimit/limiter.js';
import { createRecords } from '../../src/records/service.js';
import { createTable, loadTable } from '../../src/tables/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createSession,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type Base = typeof bases.$inferSelect;
type Table = typeof tables.$inferSelect;
type Json = ReturnType<typeof JSON.parse>;

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * Automation triggers and actions of as openrows_app: form submitted, webhook received
 * (URL, size, type and rate limits, rotation), button clicked (the clicker's permissions, who
 * started it), send email (addresses and user fields, the daily cap), HTTP request and Slack
 * message (encrypted secrets, redacted logs, the SSRF suite at save and at run time).
 */
describe('automation triggers and actions', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  let app: ReturnType<typeof testApp>['app'];
  let config: ReturnType<typeof testApp>['config'];
  // The rate limiter's clock: real time unless a test freezes it (the bucket refills at 5 a
  // second, so on a slow runner a burst could otherwise get a token back mid-test).
  let frozenAt: number | null = null;
  let owner: User;
  let creator: User;
  let editor: User;
  let commenter: User;
  let outsider: User;
  let cookies: Map<string, string>;
  let workspaceId: string;
  let base: Base;
  let server: Server;
  let port: number;
  const received: Received[] = [];
  let answer = 200;
  const email = memoryTransport();
  const EMAIL_LIMIT = 6;
  let outbound: OutboundDeps;

  const call = async (
    who: User | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: Json; headers: Headers }> => {
    const h = new Headers(headers);
    if (who) h.set('cookie', `${SESSION_COOKIE}=${cookies.get(who.id)}`);
    if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
    const res = await app.request(path, {
      method,
      headers: h,
      ...(body !== undefined
        ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
        : {}),
    });
    const text = await res.text();
    let parsed: Json = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const autos = () => `/api/bases/${base.id}/automations`;
  const url = (path = '/in') => `http://127.0.0.1:${port}${path}`;

  /** Jobs already run (pg-boss would skip ids it has). */
  const seen = new Set<string>();
  const run = (data: unknown, deps: Partial<OutboundDeps> = {}) =>
    runAutomationJob({ db: t.appDb, logger, outbound: { ...outbound, ...deps } }, data);

  /** Runs the automation jobs the app sent (webhook and button runs). */
  const runSent = async (deps: Partial<OutboundDeps> = {}) => {
    const { rows } = await t.db.execute<{ id: string; data: unknown }>(
      sql`SELECT id, data FROM pgboss.job WHERE name = 'automations.run' ORDER BY created_on`
    );
    const outcomes = [];
    for (const job of rows) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      outcomes.push(await run(job.data, deps));
    }
    return outcomes;
  };

  /** Relays the outbox to automations and runs the jobs (form submissions). */
  const pump = async () => {
    const jobs: JobInsert<RelayJobData>[] = [];
    const deadline = Date.now() + 20_000;
    for (;;) {
      await relayOutbox(
        t.appDb,
        async (_queue, batch) => {
          jobs.push(...batch);
        },
        [automationSubscriber]
      );
      const { rows } = await t.db.execute<{ pending: string }>(
        sql`SELECT pending FROM outbox_relay_lag()`
      );
      if (Number(rows[0]?.pending ?? 0) === 0) break;
      if (Date.now() > deadline) throw new Error('pump: the relay is held back');
      await new Promise((r) => setTimeout(r, 100));
    }
    const outcomes = [];
    for (const job of jobs) {
      if (job.id && seen.has(job.id)) continue;
      if (job.id) seen.add(job.id);
      outcomes.push(await run(job.data));
    }
    return outcomes;
  };

  interface Made {
    table: Table;
    name: string;
    notes: string;
  }
  const makeTable = (name: string): Promise<Made> =>
    inScope(t.appDb, { userId: owner.id, workspaceId }, async (tx) => {
      const created = await createTable({ tx, workspaceId, userId: owner.id }, base, { name });
      const table = await loadTable(tx, created.id);
      const byName = (n: string) => {
        const f = created.fields.find((x) => x.name === n);
        if (!f) throw new Error(`no ${n}`);
        return f.id;
      };
      return { table, name: byName('Name'), notes: byName('Notes') };
    });
  const addField = (m: Made, input: Parameters<typeof createField>[2]) =>
    inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
      createField({ tx, workspaceId, userId: owner.id }, m.table, input)
    );
  const addRecord = async (m: Made, cells: Record<string, unknown>) => {
    const [r] = await inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
      createRecords(
        {
          tx,
          workspaceId,
          userId: owner.id,
          role: 'owner',
          entitlements: unlimitedEntitlements(),
          table: m.table,
        },
        [cells]
      )
    );
    if (!r) throw new Error('no record');
    return r;
  };
  const cellsOf = async (m: Made) => {
    const cols = new Map(
      (await t.db.select().from(fields).where(eq(fields.tableId, m.table.id))).map((f) => [
        f.id,
        f.dbColumn,
      ])
    );
    const { rows } = await t.db.execute<Record<string, unknown>>(
      sql`SELECT * FROM ${qualified(m.table)} WHERE deleted_at IS NULL ORDER BY id`
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      name: r[cols.get(m.name) ?? ''],
      notes: r[cols.get(m.notes) ?? ''],
    }));
  };

  const create = async (body: Record<string, unknown>, who = creator) => {
    const res = await call(who, 'POST', autos(), { name: 'A', enabled: true, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; webhookUrl: string | null; actions: Json[] };
  };
  const runsOf = async (id: string) => {
    const res = await call(creator, 'GET', `${autos()}/${id}/runs?limit=100`);
    expect(res.status).toBe(200);
    return res.body.runs as {
      status: string;
      error: string | null;
      triggeredBy: string | null;
      trigger: Json;
      steps: { status: string; error: string | null; input: Json; output: Json }[];
    }[];
  };
  const hookPath = (webhookUrl: string | null) => new URL(webhookUrl ?? '').pathname;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        res.writeHead(answer, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: answer < 300, id: 'ext-1' }));
      });
    });
    port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    );
    const built = testApp({
      db: t.appDb,
      email,
      rateLimiter: new MemoryRateLimiter(() => frozenAt ?? Date.now()),
      env: {
        OUTBOUND_HTTP_ALLOW_HTTP: 'true',
        OUTBOUND_HTTP_PORTS: String(port),
        OUTBOUND_HTTP_ALLOW: '127.0.0.1',
      },
    });
    app = built.app;
    config = built.config;
    outbound = {
      cipher: createCipher(config.encryptionKey, 'automation-secret'),
      http: createSafeFetch(
        outboundPolicy({ allowHttp: true, extraPorts: [port], allow: ['127.0.0.1'], deny: [] })
      ),
      email,
      emailDailyLimit: EMAIL_LIMIT,
    };
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    creator = await addMember(t.db, workspaceId, 'creator');
    editor = await addMember(t.db, workspaceId, 'editor');
    commenter = await addMember(t.db, workspaceId, 'commenter');
    outsider = await createUser(t.db);
    cookies = new Map();
    for (const u of [owner, creator, editor, commenter, outsider]) {
      cookies.set(u.id, await createSession(t.db, u));
    }
    base = await createBase(t.db, workspaceId, { name: 'Ops' });
    await pump();
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  describe('form submitted', () => {
    it("runs for its form's submissions only, and emails the answer", async () => {
      const m = await makeTable('Intake');
      const view = async (name: string) => {
        const v = await call(owner, 'POST', `/api/tables/${m.table.id}/views`, {
          name,
          type: 'form',
        });
        expect(v.status).toBe(201);
        await call(owner, 'PATCH', `/api/views/${v.body.id}`, {
          form: { title: name, fields: [{ fieldId: m.name, required: true }] },
        });
        const share = await call(owner, 'POST', `/api/views/${v.body.id}/shares`, {});
        expect(share.status).toBe(201);
        return { id: v.body.id as string, token: share.body.token as string };
      };
      const form = await view('Requests');
      const other = await view('Other form');
      const auto = await create({
        trigger: { type: 'formSubmitted', tableId: m.table.id, viewId: form.id },
        actions: [
          {
            type: 'sendEmail',
            to: ['team@example.com'],
            subject: 'New request: {{trigger.record.fields.Name}}',
            body: '**{{trigger.record.fields.Name}}** came in. <script>x</script>',
          },
        ],
      });
      const submit = (token: string, name: string) =>
        call(null, 'POST', `/api/forms/${token}/submissions`, {
          submissionId: uuidv7(),
          fields: { [m.name]: name },
        });
      expect((await submit(form.token, 'Laptop')).status).toBe(201);
      expect((await submit(other.token, 'Ignored')).status).toBe(201);
      const before = email.sent.length;
      await pump();
      const sent = email.sent.slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'team@example.com', subject: 'New request: Laptop' });
      expect(sent[0]?.html).toContain('<strong>Laptop</strong>');
      expect(sent[0]?.html).not.toContain('<script>');
      expect(sent[0]?.text).toContain('**Laptop** came in.');
      const runs = await runsOf(auto.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'succeeded', trigger: { type: 'formSubmitted' } });
    });

    it('refuses a view that is not a form of the table', async () => {
      const m = await makeTable('Not a form');
      const grid = await call(owner, 'POST', `/api/tables/${m.table.id}/views`, { name: 'G' });
      const res = await call(creator, 'POST', autos(), {
        name: 'Bad',
        trigger: { type: 'formSubmitted', tableId: m.table.id, viewId: grid.body.id },
      });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain('trigger.viewId');
    });
  });

  describe('webhook received', () => {
    it('runs with the JSON body, keeps a sample, and its URL is the credential', async () => {
      const m = await makeTable('Hooks');
      const auto = await create({
        trigger: { type: 'webhookReceived' },
        actions: [
          {
            type: 'createRecord',
            tableId: m.table.id,
            fields: { [m.name]: '{{trigger.body.name}}' },
          },
        ],
      });
      expect(auto.webhookUrl).toMatch(/\/hooks\/a\/[A-Za-z0-9_-]{32}$/);
      const path = hookPath(auto.webhookUrl);
      // Stored as a hash and encrypted, never in clear.
      const [row] = await t.db.select().from(automations).where(eq(automations.id, auto.id));
      const token = path.split('/').pop() ?? '';
      expect(row?.hookTokenHash).not.toBe(token);
      expect(row?.hookTokenEncrypted?.toString('utf8')).not.toContain(token);

      const res = await call(null, 'POST', path, { name: 'From Zapier', n: 1 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      await runSent();
      expect((await cellsOf(m)).map((r) => r.name)).toEqual(['From Zapier']);
      const got = await call(creator, 'GET', `${autos()}/${auto.id}`);
      expect(got.body.webhookSample).toMatchObject({ body: { name: 'From Zapier', n: 1 } });
      expect(got.body.webhookUrl).toBe(auto.webhookUrl);

      // Unknown and malformed tokens, other types, bad JSON and big bodies.
      expect((await call(null, 'POST', `/hooks/a/${'x'.repeat(32)}`, {})).status).toBe(404);
      expect((await call(null, 'POST', '/hooks/a/short', {})).status).toBe(404);
      const text = await call(null, 'POST', path, 'hello', { 'content-type': 'text/plain' });
      expect(text.status).toBe(415);
      expect((await call(null, 'POST', path, '{nope')).status).toBe(400);
      const big = await call(null, 'POST', path, { pad: 'x'.repeat(101 * 1024) });
      expect(big.status).toBe(413);

      // Rotated: the old URL is gone at once.
      const rotated = await call(creator, 'POST', `${autos()}/${auto.id}/webhook-url`);
      expect(rotated.status).toBe(200);
      expect(rotated.body.webhookUrl).not.toBe(auto.webhookUrl);
      expect((await call(null, 'POST', path, {})).status).toBe(404);
      const fresh = hookPath(rotated.body.webhookUrl);
      expect((await call(null, 'POST', fresh, { name: 'Second' })).status).toBe(200);
      // Off: 404 too.
      await call(creator, 'PATCH', `${autos()}/${auto.id}`, { enabled: false });
      expect((await call(null, 'POST', fresh, {})).status).toBe(404);
      await runSent();
      // Turned off before its run: the queued run does nothing.
      expect((await cellsOf(m)).map((r) => r.name)).toEqual(['From Zapier']);
    });

    it('is rate-limited per URL', async () => {
      const m = await makeTable('Burst');
      const auto = await create({
        trigger: { type: 'webhookReceived' },
        actions: [{ type: 'createRecord', tableId: m.table.id, fields: { [m.name]: 'x' } }],
      });
      const path = hookPath(auto.webhookUrl);
      const statuses: number[] = [];
      frozenAt = Date.now();
      try {
        for (let i = 0; i < 25; i++) statuses.push((await call(null, 'POST', path, { i })).status);
        expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
        expect(statuses.slice(20)).toEqual(Array(5).fill(429));
        const limited = await call(null, 'POST', path, {});
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
        // A second later the bucket has 5 tokens again.
        frozenAt += 1000;
        expect((await call(null, 'POST', path, {})).status).toBe(200);
      } finally {
        frozenAt = null;
      }
      await call(creator, 'PATCH', `${autos()}/${auto.id}`, { enabled: false });
      await runSent();
    });
  });

  describe('button clicked', () => {
    it("runs as the creator, records the clicker, and checks the clicker's rights", async () => {
      const m = await makeTable('Buttons');
      const button = await addField(m, {
        name: 'Approve',
        type: 'button',
        options: { label: 'Approve', action: 'runAutomation' },
      });
      const link = await addField(m, {
        name: 'Open',
        type: 'button',
        options: { label: 'Open', formula: '"https://openrows.io"' },
      });
      const record = await addRecord(m, { [m.name]: 'Invoice' });
      const auto = await create({
        trigger: { type: 'buttonClicked', tableId: m.table.id, fieldId: button.id },
        actions: [
          {
            type: 'updateRecord',
            tableId: m.table.id,
            recordId: '{{trigger.record.id}}',
            fields: { [m.notes]: 'Approved by {{trigger.user.name}}' },
          },
        ],
      });
      const click = (who: User, fieldId = button.id, recordId = record.id) =>
        call(who, 'POST', `/api/tables/${m.table.id}/records/${recordId}/buttons/${fieldId}`);

      const ok = await click(editor);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toEqual({ started: 1 });
      await runSent();
      const [cells] = await cellsOf(m);
      expect(cells?.notes).toBe(`Approved by ${editor.name}`);
      const runs = await runsOf(auto.id);
      expect(runs[0]).toMatchObject({ status: 'succeeded', triggeredBy: editor.id });
      expect(runs[0]?.trigger).toMatchObject({ type: 'buttonClicked', user: { id: editor.id } });

      expect((await click(commenter)).status).toBe(403);
      expect((await click(outsider)).status).toBe(404);
      expect((await click(editor, link.id)).status).toBe(409);
      expect((await click(editor, m.notes)).status).toBe(404);
      expect((await click(editor, button.id, uuidv7())).status).toBe(404);
      // The table's "edit records" permission binds the clicker too.
      await t.db
        .update(tables)
        .set({ permissions: { editRecords: { level: 'creators' } } })
        .where(eq(tables.id, m.table.id));
      const restricted = await click(editor);
      expect(restricted.status).toBe(403);
      expect(restricted.body.code).toBe('EDIT_RESTRICTED');
      expect((await click(creator)).status).toBe(200);
      await runSent();
    });

    it('needs a button field of the table as its trigger', async () => {
      const m = await makeTable('Not a button');
      const res = await call(creator, 'POST', autos(), {
        name: 'Bad',
        trigger: { type: 'buttonClicked', tableId: m.table.id, fieldId: m.notes },
      });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain('trigger.fieldId');
    });
  });

  describe('send email', () => {
    it('sends to addresses and user fields, skips people without access, and stops at the daily cap', async () => {
      const m = await makeTable('Mail');
      const people = await addField(m, {
        name: 'People',
        type: 'user',
        options: { multiple: true },
      });
      // A collaborator who has left since the cell was set: skipped.
      const leaver = await addMember(t.db, workspaceId, 'editor');
      const record = await addRecord(m, {
        [m.name]: 'Kickoff',
        [people.id]: [editor.id, leaver.id],
      });
      await t.db.delete(workspaceMembers).where(eq(workspaceMembers.userId, leaver.id));
      await t.db
        .delete(automationEmailCounts)
        .where(eq(automationEmailCounts.workspaceId, workspaceId));
      const auto = await create({
        trigger: { type: 'webhookReceived' },
        actions: [
          { type: 'findRecords', tableId: m.table.id, limit: 1 },
          {
            type: 'sendEmail',
            to: ['{{steps.1.records[0].fields.People}}', 'boss@example.com, ops@example.com'],
            subject: '{{steps.1.records[0].fields.Name}}',
            body: 'Hello',
          },
        ],
      });
      expect(record.id).toBeTruthy();
      const path = hookPath(auto.webhookUrl);
      const before = email.sent.length;
      await call(null, 'POST', path, {});
      await call(null, 'POST', path, {});
      await call(null, 'POST', path, {});
      await runSent();
      const sent = email.sent.slice(before);
      // 3 recipients each (the leaver has no access): 2 runs fit the cap of 6, the third doesn't.
      expect(sent.map((s) => s.to).sort()).toEqual(
        [
          editor.email,
          'boss@example.com',
          'ops@example.com',
          editor.email,
          'boss@example.com',
          'ops@example.com',
        ]
          .map((e) => (e ?? '').toLowerCase())
          .sort()
      );
      const runs = await runsOf(auto.id);
      expect(runs.map((r) => r.status).sort()).toEqual(['failed', 'succeeded', 'succeeded']);
      const failed = runs.find((r) => r.status === 'failed');
      expect(failed?.steps[1]?.error).toContain(`limit of ${EMAIL_LIMIT} automation emails`);
      expect(runs.find((r) => r.status === 'succeeded')?.steps[1]?.output).toMatchObject({
        sent: 3,
        skipped: 1,
      });
      const [count] = await t.db
        .select()
        .from(automationEmailCounts)
        .where(eq(automationEmailCounts.workspaceId, workspaceId));
      expect(count?.sent).toBe(6);
      await call(creator, 'PATCH', `${autos()}/${auto.id}`, { enabled: false });
    });

    it('fails the step on a malformed address', async () => {
      const auto = await create({
        trigger: { type: 'webhookReceived' },
        actions: [{ type: 'sendEmail', to: ['{{trigger.body.to}}'], subject: 'Hi', body: '' }],
      });
      await call(null, 'POST', hookPath(auto.webhookUrl), { to: 'not an address' });
      await runSent();
      const [r] = await runsOf(auto.id);
      expect(r?.status).toBe('failed');
      expect(r?.steps[0]?.error).toContain("isn't an email address");
      await call(creator, 'PATCH', `${autos()}/${auto.id}`, { enabled: false });
    });
  });

  describe('HTTP request and Slack message', () => {
    const SECRET = 'Bearer sk_live_very_secret_value';
    const SLACK_PATH = '/services/T000/B000/slacksecretpath';

    it('sends with secret headers stored encrypted, never shown, and redacted in run logs', async () => {
      received.length = 0;
      const auto = await create({
        trigger: { type: 'webhookReceived' },
        actions: [
          {
            type: 'httpRequest',
            method: 'POST',
            url: url('/orders?key={{trigger.body.key}}'),
            headers: [
              { name: 'Authorization', value: SECRET, secret: true },
              { name: 'X-Order', value: '{{trigger.body.order}}' },
            ],
            body: { order: '{{trigger.body.order}}', n: 2 },
          },
          {
            type: 'slackMessage',
            webhookUrl: url(SLACK_PATH),
            text: 'Order {{trigger.body.order}}: {{steps.1.body.id}}',
          },
        ],
      });
      const shown = JSON.stringify(auto);
      expect(shown).not.toContain('sk_live');
      expect(shown).not.toContain('slacksecretpath');
      const [row] = await t.db.select().from(automations).where(eq(automations.id, auto.id));
      expect(JSON.stringify(row?.actions)).not.toContain('sk_live');
      expect(JSON.stringify(row?.actions)).not.toContain('slacksecretpath');
      expect(row?.secretsEncrypted?.toString('utf8') ?? '').not.toContain('sk_live');

      await call(null, 'POST', hookPath(auto.webhookUrl), { order: 'A-17', key: 'q1' });
      await runSent();
      expect(received).toHaveLength(2);
      expect(received[0]).toMatchObject({ method: 'POST', url: '/orders?key=q1' });
      expect(received[0]?.headers['authorization']).toBe(SECRET);
      expect(received[0]?.headers['x-order']).toBe('A-17');
      expect(received[0]?.headers['content-type']).toBe('application/json');
      expect(JSON.parse(received[0]?.body ?? '')).toEqual({ order: 'A-17', n: 2 });
      expect(received[1]).toMatchObject({ method: 'POST', url: SLACK_PATH });
      expect(JSON.parse(received[1]?.body ?? '')).toEqual({ text: 'Order A-17: ext-1' });

      const runs = await runsOf(auto.id);
      expect(runs[0]?.status).toBe('succeeded');
      const log = JSON.stringify(runs);
      expect(log).not.toContain('sk_live');
      expect(log).not.toContain('slacksecretpath');
      expect(log).not.toContain('key=q1');
      expect(runs[0]?.steps[0]?.input.headers).toEqual([
        { name: 'Authorization', value: REDACTED, secret: true },
        { name: 'X-Order', value: REDACTED, secret: false },
      ]);
      expect(runs[0]?.steps[1]?.input.webhookUrl).toBe(REDACTED);

      // Saved back as read (no secret values): the secrets are kept.
      const kept = await call(creator, 'PATCH', `${autos()}/${auto.id}`, {
        actions: auto.actions,
      });
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      received.length = 0;
      await call(null, 'POST', hookPath(auto.webhookUrl), { order: 'B-2', key: 'q2' });
      await runSent();
      expect(received[0]?.headers['authorization']).toBe(SECRET);
      expect(received[1]?.url).toBe(SLACK_PATH);

      // A new URL doesn't take the stored secret along: it must be entered again.
      const moved = structuredClone(auto.actions);
      moved[0].url = url('/elsewhere');
      const refused = await call(creator, 'PATCH', `${autos()}/${auto.id}`, { actions: moved });
      expect(refused.status).toBe(422);
      expect(JSON.stringify(refused.body)).toContain('actions.0.headers.0.value');

      // A non-2xx answer fails the step and skips the rest.
      answer = 500;
      received.length = 0;
      await call(null, 'POST', hookPath(auto.webhookUrl), { order: 'C-3' });
      await runSent();
      answer = 200;
      const [last] = await runsOf(auto.id);
      expect(last?.status).toBe('failed');
      expect(last?.steps[0]?.error).toContain('500');
      expect(last?.steps[1]?.status).toBe('skipped');
      await call(creator, 'PATCH', `${autos()}/${auto.id}`, { enabled: false });
    });

    it('needs the value of a new secret header and a Slack URL', async () => {
      const missing = await call(creator, 'POST', autos(), {
        name: 'Bad',
        trigger: { type: 'webhookReceived' },
        actions: [
          { type: 'httpRequest', url: url(), headers: [{ name: 'Authorization', secret: true }] },
          { type: 'slackMessage', text: 'hi' },
        ],
      });
      expect(missing.status).toBe(422);
      const text = JSON.stringify(missing.body);
      expect(text).toContain('actions.0.headers.0.value');
      expect(text).toContain('actions.1.webhookUrl');
      const tokenHost = await call(creator, 'POST', autos(), {
        name: 'Bad',
        trigger: { type: 'webhookReceived' },
        actions: [
          {
            type: 'httpRequest',
            url: 'https://{{trigger.body.host}}/x',
            headers: [{ name: 'Authorization', value: 'k', secret: true }],
          },
        ],
      });
      expect(tokenHost.status).toBe(422);
      expect(JSON.stringify(tokenHost.body)).toContain("host can't hold tokens");
      const injected = await call(creator, 'POST', autos(), {
        name: 'Bad',
        trigger: { type: 'webhookReceived' },
        actions: [
          { type: 'httpRequest', url: url(), headers: [{ name: 'X', value: 'a\r\nB: c' }] },
        ],
      });
      expect(injected.status).toBe(422);
    });

    describe('the SSRF suite', () => {
      // The suite's policy: http and port 8080 allowed, nothing allowlisted.
      let strict: ReturnType<typeof testApp>['app'] | undefined;
      it.each(REFUSED_URLS)('refuses %s at save, for HTTP and Slack steps', async (target) => {
        strict ??= testApp({
          db: t.appDb,
          env: { OUTBOUND_HTTP_ALLOW_HTTP: 'true', OUTBOUND_HTTP_PORTS: '8080' },
        }).app;
        for (const action of [
          { type: 'httpRequest', url: target },
          { type: 'slackMessage', webhookUrl: target, text: 'x' },
        ]) {
          const res = await strict.request(autos(), {
            method: 'POST',
            headers: {
              cookie: `${SESSION_COOKIE}=${cookies.get(creator.id)}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              name: 'SSRF',
              trigger: { type: 'webhookReceived' },
              actions: [action],
            }),
          });
          expect(res.status, `${action.type} ${target}`).toBe(422);
        }
      });

      it('refuses every one of them at run time too (URLs from tokens, Slack URLs)', async () => {
        const strictHttp = createSafeFetch(
          outboundPolicy({ allowHttp: true, extraPorts: [8080], allow: [], deny: [] })
        );
        received.length = 0;
        const auto = await create({
          trigger: { type: 'webhookReceived' },
          actions: [{ type: 'httpRequest', method: 'GET', url: '{{trigger.body.url}}' }],
        });
        const slack = await create({
          trigger: { type: 'webhookReceived' },
          actions: [{ type: 'slackMessage', webhookUrl: url('/slack'), text: 'x' }],
        });
        // As the hook route would send them (more than its rate limit lets through at once).
        for (const target of REFUSED_URLS) {
          await run(
            {
              workspaceId,
              subscriberId: auto.id,
              hook: {
                requestId: uuidv7(),
                receivedAt: new Date().toISOString(),
                body: { url: target },
              },
            },
            { http: strictHttp }
          );
        }
        await call(null, 'POST', hookPath(slack.webhookUrl), {});
        // The Slack URL passed the allowlist at save; the worker's rules refuse it now.
        await runSent({ http: strictHttp });
        expect(received).toEqual([]);
        const runs = await runsOf(auto.id);
        expect(runs).toHaveLength(REFUSED_URLS.length);
        for (const r of runs) {
          expect(r.status).toBe('failed');
          expect(r.steps[0]?.error).toMatch(/request failed/);
        }
        const [s] = await runsOf(slack.id);
        expect(s?.status).toBe('failed');
        expect(s?.steps[0]?.error).toMatch(/request failed/);
        for (const id of [auto.id, slack.id]) {
          await call(creator, 'PATCH', `${autos()}/${id}`, { enabled: false });
        }
      });
    });
  });

  describe('tests and retries (#111)', () => {
    it('tests a webhook trigger with its last request, and retries a failed run with its body', async () => {
      const m = await makeTable('Hook tests');
      const auto = await create({
        trigger: { type: 'webhookReceived' },
        actions: [
          {
            type: 'createRecord',
            tableId: m.table.id,
            fields: { [m.name]: '{{trigger.body.name}}' },
          },
          { type: 'httpRequest', method: 'POST', url: url('/tested'), body: { n: 1 } },
        ],
      });
      const test = () => call(creator, 'POST', `${autos()}/${auto.id}/test`, {});
      const none = await test();
      expect(none.status).toBe(409);
      expect(none.body.detail).toBe(
        'Send a request to the webhook URL first; a test uses the last one it received.'
      );

      // A live run whose HTTP step fails: its first step's record stays.
      answer = 500;
      expect((await call(null, 'POST', hookPath(auto.webhookUrl), { name: 'Hooked' })).status).toBe(
        200
      );
      await runSent();
      answer = 200;
      const [failed] = await runsOf(auto.id);
      expect(failed?.status).toBe('failed');
      expect((await cellsOf(m)).map((r) => r.name)).toEqual(['Hooked']);

      // The test runs both steps in the API, with its outbound client.
      received.length = 0;
      const tested = await test();
      expect(tested.status, JSON.stringify(tested.body)).toBe(200);
      expect(tested.body).toMatchObject({ status: 'succeeded', mode: 'test' });
      expect(tested.body.trigger).toMatchObject({
        type: 'webhookReceived',
        body: { name: 'Hooked' },
      });
      expect(received.map((r) => r.url)).toEqual(['/tested']);

      // The retry reuses the failed run's body (the webhook got another request since).
      expect((await call(null, 'POST', hookPath(auto.webhookUrl), { name: 'Later' })).status).toBe(
        200
      );
      await runSent();
      const failedId = (failed as unknown as { id: string }).id;
      const retried = await call(owner, 'POST', `${autos()}/${auto.id}/runs/${failedId}/retry`);
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      expect(retried.body).toMatchObject({
        status: 'succeeded',
        mode: 'retry',
        retryOf: failedId,
        triggeredBy: owner.id,
      });
      expect(retried.body.trigger).toMatchObject({ body: { name: 'Hooked' } });
      expect((await cellsOf(m)).map((r) => r.name).sort()).toEqual([
        'Hooked',
        'Hooked',
        'Hooked',
        'Later',
      ]);
      await call(creator, 'PATCH', `${autos()}/${auto.id}`, { enabled: false });
    });

    it('tests a button trigger as the tester; a retry keeps who clicked', async () => {
      const m = await makeTable('Button tests');
      const button = await addField(m, {
        name: 'Approve',
        type: 'button',
        options: { label: 'Approve', action: 'runAutomation' },
      });
      const record = await addRecord(m, { [m.name]: 'Invoice' });
      const auto = await create({
        enabled: false,
        trigger: { type: 'buttonClicked', tableId: m.table.id, fieldId: button.id },
        actions: [
          {
            type: 'updateRecord',
            tableId: m.table.id,
            recordId: '{{trigger.record.id}}',
            fields: { [m.notes]: 'Approved by {{trigger.user.name}}' },
          },
        ],
      });
      const tested = await call(creator, 'POST', `${autos()}/${auto.id}/test`, {
        recordId: record.id,
      });
      expect(tested.status, JSON.stringify(tested.body)).toBe(200);
      expect(tested.body).toMatchObject({ status: 'succeeded', triggeredBy: creator.id });
      expect(tested.body.trigger).toMatchObject({
        type: 'buttonClicked',
        fieldId: button.id,
        user: { id: creator.id },
      });
      expect((await cellsOf(m))[0]?.notes).toBe(`Approved by ${creator.name}`);

      // The editor's click failed (say): the owner retries it, the editor still clicked.
      const [failed] = await t.db
        .insert(automationRuns)
        .values({
          workspaceId,
          automationId: auto.id,
          idempotencyKey: `button:${uuidv7()}`,
          status: 'failed',
          depth: 1,
          triggeredBy: editor.id,
          trigger: {
            type: 'buttonClicked',
            fieldId: button.id,
            record: { id: record.id, fields: {} },
            user: { id: editor.id, name: editor.name, email: editor.email },
          },
          error: 'Step 1 failed: x',
        })
        .returning();
      const retried = await call(owner, 'POST', `${autos()}/${auto.id}/runs/${failed?.id}/retry`);
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      expect(retried.body).toMatchObject({ status: 'succeeded', triggeredBy: owner.id });
      expect(retried.body.trigger).toMatchObject({ user: { id: editor.id } });
      expect((await cellsOf(m))[0]?.notes).toBe(`Approved by ${editor.name}`);
    });
  });

  it('keeps runs of other tenants apart (a job naming another workspace runs nothing)', async () => {
    const other = await createWorkspace(t.db);
    const [anyAuto] = await t.db
      .select({ id: automations.id })
      .from(automations)
      .where(eq(automations.workspaceId, workspaceId))
      .limit(1);
    const outcome = await run({
      workspaceId: other.workspace.id,
      subscriberId: anyAuto?.id,
      hook: { requestId: uuidv7(), receivedAt: new Date().toISOString(), body: {} },
    });
    expect(outcome).toEqual({ skipped: 'disabled' });
    const [count] = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(automationRuns)
      .where(eq(automationRuns.workspaceId, other.workspace.id));
    expect(count?.n).toBe(0);
  });
});
