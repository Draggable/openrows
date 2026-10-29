import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import { runAutomationJob } from '../../src/automations/run.js';
import {
  createLocalContainerExecutor,
  createScriptBridge,
  createScriptSandbox,
  DEFAULT_SCRIPT_IMAGE,
  type ScriptBridge,
  ScriptCallError,
  type ScriptLimits,
  type ScriptSandbox,
} from '../../src/automations/script/index.js';
import { qualified } from '../../src/data/columns.js';
import { type bases, fields, type tables, type users } from '../../src/db/index.js';
import { unlimitedEntitlements } from '../../src/edition/oss.js';
import { memoryTransport } from '../../src/email/transport.js';
import { createLogger } from '../../src/lib/logger.js';
import { createSafeFetch, outboundPolicy } from '../../src/lib/safe-fetch/index.js';
import { createRecords } from '../../src/records/service.js';
import { createTable, loadTable } from '../../src/tables/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createBase, createSession, createWorkspace } from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type Base = typeof bases.$inferSelect;
type Table = typeof tables.$inferSelect;
type Json = ReturnType<typeof JSON.parse>;

const CONFIG = { docker: 'docker', image: DEFAULT_SCRIPT_IMAGE, runtime: undefined };
const LIMITS: ScriptLimits = { timeoutSeconds: 20, cpuSeconds: 5, memoryMb: 128 };
const EMPTY_BASE = { id: 'b', name: 'Base', tables: [] };

/** Script containers still on the Docker host (the suite must leave none). */
function scriptContainers(): string[] {
  return execFileSync('docker', ['ps', '-aq', '--filter', 'label=openrows.script=1'])
    .toString()
    .split('\n')
    .filter(Boolean);
}

/**
 * Run-script steps against the real Docker: the escape suite (the script's scope, the
 * eval escapes, prototype pollution, the container's limits and hardening with full Node access
 * inside it, infinite loops, memory bombs, timing) and whole automations through the API and the
 * worker (input, base calls as the run's person, fetch through the SSRF-safe client, outputs to
 * later steps, permissions, other bases, availability).
 */
describe('run-script steps', () => {
  const executor = createLocalContainerExecutor({ ...CONFIG, concurrency: 4 });
  const run = (script: string, bridge: ScriptBridge = async () => null, limits = LIMITS) =>
    executor.run({ script, config: { who: 'tester' }, base: EMPTY_BASE, limits }, bridge);

  afterAll(() => {
    expect(scriptContainers()).toEqual([]);
  });

  describe('escape suite', () => {
    it('gives the script only input, output, base, fetch and console', async () => {
      const r = await run(`
        output.set('types', [typeof process, typeof require, typeof module, typeof Buffer,
          typeof setTimeout, typeof setInterval, typeof globalThis.process, typeof WebAssembly.compile]);
        output.set('globals', Object.getOwnPropertyNames(globalThis).filter((k) =>
          ['input', 'output', 'base', 'fetch', 'console', 'process', 'require'].includes(k)).sort());
        output.set('config', input.config());
      `);
      expect(r.error).toBeNull();
      expect(r.output['types']).toEqual([
        'undefined',
        'undefined',
        'undefined',
        'undefined',
        'undefined',
        'undefined',
        'undefined',
        'function',
      ]);
      expect(r.output['globals']).toEqual(['base', 'console', 'fetch', 'input', 'output']);
      expect(r.output['config']).toEqual({ who: 'tester' });
    });

    it('refuses the constructor, eval and import escapes', async () => {
      const r = await run(`
        const attempts = {
          constructor: () => this.constructor.constructor('return process')(),
          inputFn: () => input.config.constructor('return process')(),
          eval: () => eval('1 + 1'),
          Function: () => Function('return 1')(),
          asyncFn: () => (async () => {}).constructor('return 1')(),
          proto: () => Object.getPrototypeOf(output).constructor.constructor('return process')(),
          wasm: () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
        };
        const results = {};
        for (const [k, f] of Object.entries(attempts)) {
          try { results[k] = 'escaped: ' + typeof f(); } catch (e) { results[k] = e.name; }
        }
        try { await import('node:fs'); results.import = 'escaped'; } catch (e) { results.import = e.name; }
        output.set('results', results);
      `);
      expect(r.error).toBeNull();
      const results = r.output['results'] as Record<string, string>;
      for (const [k, v] of Object.entries(results)) {
        expect(v, k).not.toMatch(/^escaped/);
      }
      expect(results['constructor']).toBe('EvalError');
      expect(results['eval']).toBe('EvalError');
      expect(results['Function']).toBe('EvalError');
    });

    it("can't pollute the server's prototypes, through outputs or call arguments", async () => {
      let received: unknown;
      const r = await run(
        `
        Object.prototype.polluted = 'yes';
        output.set('data', JSON.parse('{"__proto__": {"polluted": "yes"}, "a": 1}'));
        let refused = null;
        try { output.set('__proto__', { polluted: 'yes' }); } catch (e) { refused = e.message; }
        output.set('refused', refused);
        await base.getTable; // the base object is frozen
        try { base.getTable = null; } catch {}
        output.set('frozen', typeof base.getTable);
        await fetch('https://example.com', { headers: JSON.parse('{"__proto__": {"polluted": "yes"}}') }).catch(() => {});
      `,
        async (_method, args) => {
          received = args;
          throw new ScriptCallError('no');
        }
      );
      expect(r.error).toBeNull();
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(Object.hasOwn(r.output['data'] as object, '__proto__')).toBe(true);
      expect(r.output['refused']).toMatch(/can't be an output name/);
      expect(r.output['frozen']).toBe('function');
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(Object.getPrototypeOf((received as { headers: object }).headers)).toBe(
        Object.prototype
      );
    });

    it('stops an infinite loop at the CPU limit', async () => {
      const r = await run('while (true) {}', undefined, { ...LIMITS, cpuSeconds: 2 });
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/CPU/);
      expect(r.durationMs).toBeLessThan(15_000);
    });

    it('stops a script that never finishes at the wall clock', async () => {
      const r = await run('await new Promise(() => {});', undefined, {
        ...LIMITS,
        timeoutSeconds: 3,
      });
      expect(r.status).toBe('failed');
      expect(r.error).toBe('The script ran longer than 3 s.');
      expect(r.durationMs).toBeLessThan(10_000);
    });

    it('stops a memory bomb at the memory limit', async () => {
      const r = await run('const a = []; while (true) a.push(new Array(1e6).fill(Math.random()));');
      expect(r.status).toBe('failed');
      expect(r.error).toMatch(/128 MB of memory/);
    });

    it('caps what a script prints, outputs and calls', async () => {
      const flood = await run(
        `const s = 'x'.repeat(1900); for (let i = 0; i < 1e5; i++) console.log(s);`
      );
      expect(flood.error).toBeNull();
      expect(flood.logs.length).toBeLessThanOrEqual(201);
      expect(flood.logs.at(-1)?.text).toBe('[more logs left out]');

      const big = await run(`output.set('a', 'x'.repeat(70000));`);
      expect(big.error).toMatch(/larger than 64 KB/);

      let calls = 0;
      const many = await run(
        `for (let i = 0; i < 600; i++) await fetch('https://example.com/' + i);`,
        async () => {
          calls += 1;
          return { status: 200, statusText: 'OK', headers: {}, body: '' };
        }
      );
      expect(many.error).toBe('The script made more than 500 calls.');
      expect(calls).toBeLessThanOrEqual(500);
    });

    it('reports a thrown error with its line, and keeps the logs', async () => {
      const r = await run(`console.log('starting', { n: 1 });\n\nthrow new TypeError('boom');`);
      expect(r.status).toBe('failed');
      expect(r.error).toBe('TypeError: boom (line 3)');
      expect(r.logs).toEqual([{ level: 'log', text: 'starting {"n":1}' }]);
    });

    it("can't tell the server's timing or reach it: a call is the only way out", async () => {
      // Timing: the script's clock is the container's, its calls are answered one at a time in
      // order, and a slow call still counts against its wall clock.
      const slow: ScriptBridge = () => new Promise((r) => setTimeout(() => r({ ids: [] }), 4000));
      const r = await run(
        `await Promise.all([1, 2, 3].map(() => fetch('https://example.com')));`,
        slow,
        { ...LIMITS, timeoutSeconds: 3 }
      );
      expect(r.error).toBe('The script ran longer than 3 s.');
    });

    /**
     * The container holds with full Node inside it (as if the script escaped the vm context): a
     * probe program in place of the runner.
     */
    it('holds the container: no network, read-only, nobody, no capabilities, few processes', async () => {
      process.env['OPENROWS_SCRIPT_TEST_SECRET'] = 'must-not-leak';
      const probe = `
        const fs = require('node:fs'), os = require('node:os'), net = require('node:net');
        const dns = require('node:dns'), cp = require('node:child_process');
        const out = {};
        const status = fs.readFileSync('/proc/self/status', 'utf8');
        const field = (k) => (new RegExp('^' + k + ':\\\\s*(\\\\S+)', 'm').exec(status) || [])[1];
        out.uid = process.getuid();
        out.capEff = field('CapEff');
        out.noNewPrivs = field('NoNewPrivs');
        out.seccomp = field('Seccomp');
        out.interfaces = Object.keys(os.networkInterfaces());
        out.env = Object.keys(process.env).sort();
        out.secret = JSON.stringify(process.env).includes('must-not-leak');
        try { fs.writeFileSync('/escape', 'x'); out.rootWrite = 'ok'; } catch (e) { out.rootWrite = e.code; }
        try { fs.writeFileSync('/tmp/x.sh', '#!/bin/sh\\necho hi'); fs.chmodSync('/tmp/x.sh', 0o755);
              cp.execFileSync('/tmp/x.sh'); out.tmpExec = 'ok'; } catch (e) { out.tmpExec = e.code; }
        try { fs.readFileSync('/var/run/docker.sock'); out.dockerSock = 'ok'; } catch (e) { out.dockerSock = e.code; }
        const connect = () => new Promise((resolve) => {
          const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 2000 });
          s.on('connect', () => { s.destroy(); resolve('connected'); });
          s.on('timeout', () => { s.destroy(); resolve('timeout'); });
          s.on('error', (e) => resolve(e.code));
        });
        const lookup = () => new Promise((resolve) =>
          dns.lookup('example.com', (e) => resolve(e ? e.code : 'resolved')));
        const forks = () => new Promise((resolve) => {
          let started = 0, failed = 0, done = 0;
          const kids = [];
          for (let i = 0; i < 40; i++) {
            try {
              const k = cp.spawn('sleep', ['5']);
              kids.push(k);
              k.on('spawn', () => { started++; if (++done === 40) finish(); });
              k.on('error', () => { failed++; if (++done === 40) finish(); });
            } catch { failed++; if (++done === 40) finish(); }
          }
          function finish() { kids.forEach((k) => k.kill('SIGKILL')); resolve({ started, failed }); }
        });
        Promise.all([connect(), lookup(), forks()]).then(([c, l, f]) => {
          out.connect = c; out.dns = l; out.forks = f;
          process.stdout.write(JSON.stringify({ type: 'done', output: out }) + '\\n', () => process.exit(0));
        });
      `;
      const prober = createLocalContainerExecutor({
        ...CONFIG,
        concurrency: 1,
        runnerSource: probe,
      });
      const r = await prober.run(
        { script: '', config: {}, base: EMPTY_BASE, limits: LIMITS },
        async () => null
      );
      delete process.env['OPENROWS_SCRIPT_TEST_SECRET'];
      expect(r.error).toBeNull();
      const o = r.output as Record<string, Json>;
      expect(o['uid']).toBe(65534);
      expect(o['capEff']).toBe('0000000000000000');
      expect(o['noNewPrivs']).toBe('1');
      expect(o['seccomp']).toBe('2');
      expect(o['interfaces']).toEqual(['lo']);
      expect(o['secret']).toBe(false);
      expect(o['env']).not.toContain('OPENROWS_SCRIPT_TEST_SECRET');
      expect(o['env']).not.toContain('DATABASE_URL');
      expect(o['rootWrite']).toBe('EROFS');
      expect(o['tmpExec']).toBe('EACCES');
      expect(o['dockerSock']).toBe('ENOENT');
      expect(o['connect']).toMatch(/ENETUNREACH|EHOSTUNREACH|timeout/);
      expect(o['dns']).toMatch(/EAI_AGAIN|ENOTFOUND|ECONNREFUSED/);
      expect(o['forks'].failed).toBeGreaterThan(0);
      expect(o['forks'].started).toBeLessThan(32);
    });
  });

  describe('in automations', () => {
    const t = useTestDb();
    const logger = createLogger({ level: 'silent' });
    let app: ReturnType<typeof testApp>['app'];
    let offApp: ReturnType<typeof testApp>['app'];
    let planApp: ReturnType<typeof testApp>['app'];
    let owner: User;
    let creator: User;
    let cookies: Map<string, string>;
    let workspaceId: string;
    let base: Base;
    let other: Base;
    let server: Server;
    let port: number;
    let scripts: ScriptSandbox;
    let encryptionKey: string;

    const call = async (
      who: User,
      method: string,
      path: string,
      body?: unknown,
      on = app
    ): Promise<{ status: number; body: Json }> => {
      const res = await on.request(path, {
        method,
        headers: {
          cookie: `${SESSION_COOKIE}=${cookies.get(who.id)}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const autos = (b = base) => `/api/bases/${b.id}/automations`;

    interface Made {
      table: Table;
      name: string;
      notes: string;
    }
    const makeTable = (name: string, b = base): Promise<Made> =>
      inScope(t.appDb, { userId: owner.id, workspaceId }, async (tx) => {
        const created = await createTable({ tx, workspaceId, userId: owner.id }, b, { name });
        const table = await loadTable(tx, created.id);
        const byName = (n: string) => created.fields.find((x) => x.name === n)?.id ?? '';
        return { table, name: byName('Name'), notes: byName('Notes') };
      });
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
    const rowsOf = async (m: Made) => {
      const cols = new Map(
        (await t.db.select().from(fields).where(sql`${fields.tableId} = ${m.table.id}`)).map(
          (f) => [f.id, f.dbColumn]
        )
      );
      const { rows } = await t.db.execute<Record<string, unknown>>(
        sql`SELECT * FROM ${qualified(m.table)} WHERE deleted_at IS NULL ORDER BY id`
      );
      return rows.map((r) => ({
        id: r['id'] as string,
        name: r[cols.get(m.name) ?? ''] as string | null,
        notes: r[cols.get(m.notes) ?? ''] as string | null,
      }));
    };
    const automation = async (m: Made, actions: unknown[], who = creator) => {
      const res = await call(who, 'POST', autos(), {
        name: 'Script',
        trigger: { type: 'recordCreated', tableId: m.table.id },
        actions,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body as { id: string };
    };
    const test = async (id: string, recordId: string, who: User = creator) => {
      const res = await call(who, 'POST', `${autos()}/${id}/test`, { recordId });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as {
        status: string;
        error: string | null;
        steps: { status: string; error: string | null; input: Json; output: Json }[];
      };
    };

    beforeAll(async () => {
      server = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-echo': req.method ?? '' });
        res.end(JSON.stringify({ path: req.url }));
      });
      port = await new Promise<number>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      );
      const env = {
        AUTOMATION_SCRIPTS: 'local-container',
        OUTBOUND_HTTP_ALLOW_HTTP: 'true',
        OUTBOUND_HTTP_PORTS: String(port),
        OUTBOUND_HTTP_ALLOW: '127.0.0.1',
      };
      const built = testApp({ db: t.appDb, env });
      app = built.app;
      scripts = createScriptSandbox(built.config.scripts);
      encryptionKey = built.config.encryptionKey;
      offApp = testApp({ db: t.appDb }).app;
      planApp = testApp({
        db: t.appDb,
        scripts: { executor: null, limitsFor: async () => ({ available: false, reason: 'plan' }) },
      }).app;
      const w = await createWorkspace(t.db);
      owner = w.owner;
      workspaceId = w.workspace.id;
      creator = await addMember(t.db, workspaceId, 'creator');
      cookies = new Map();
      for (const u of [owner, creator]) cookies.set(u.id, await createSession(t.db, u));
      base = await createBase(t.db, workspaceId, { name: 'Ops' });
      other = await createBase(t.db, workspaceId, { name: 'Other' });
    });

    afterAll(async () => {
      await new Promise((r) => server.close(r));
    });

    it('says whether scripts are available, and refuses them where they are not', async () => {
      const list = await call(creator, 'GET', autos());
      expect(list.body.scripts).toEqual({
        available: true,
        reason: null,
        limits: { timeoutSeconds: 30, cpuSeconds: 10, memoryMb: 128 },
      });
      const m = await makeTable('Availability');
      const body = {
        name: 'S',
        trigger: { type: 'recordCreated', tableId: m.table.id },
        actions: [{ type: 'runScript', script: 'output.set("a", 1)' }],
      };
      const off = await call(creator, 'POST', autos(), body, offApp);
      expect(off.status).toBe(422);
      expect(off.body.errors).toEqual([
        { path: 'actions.0.type', message: "This server doesn't run scripts." },
      ]);
      expect((await call(creator, 'GET', autos(), undefined, offApp)).body.scripts).toEqual({
        available: false,
        reason: 'disabled',
        limits: null,
      });
      const plan = await call(creator, 'POST', autos(), body, planApp);
      expect(plan.status).toBe(422);
      expect(plan.body.errors[0].message).toBe("This workspace's plan doesn't include scripts.");

      // Saved where scripts run, it can't be turned on where they don't; a run fails the step.
      const saved = await call(creator, 'POST', autos(), body);
      expect(saved.status).toBe(201);
      const on = await call(
        creator,
        'PATCH',
        `${autos()}/${saved.body.id}`,
        { enabled: true },
        offApp
      );
      expect(on.status).toBe(422);
      const record = await addRecord(m, { [m.name]: 'x' });
      const tested = await call(
        creator,
        'POST',
        `${autos()}/${saved.body.id}/test`,
        { recordId: record.id },
        offApp
      );
      expect(tested.body.steps[0].error).toBe(
        "This server doesn't run scripts (AUTOMATION_SCRIPTS is off)."
      );
    });

    it('reads its inputs and the base, writes as the run person, and feeds later steps', async () => {
      const tasks = await makeTable('Tasks');
      const log = await makeTable('Log');
      await addRecord(tasks, { [tasks.name]: 'Older' });
      const auto = await automation(tasks, [
        {
          type: 'runScript',
          inputs: { recordId: '{{trigger.record.id}}', name: '{{trigger.record.fields.Name}}' },
          script: `
            const { recordId, name } = input.config();
            const tasks = base.getTable('Tasks');
            const query = await tasks.selectRecordsAsync({ sorts: [{ field: 'Name' }] });
            console.log('records', query.records.length);
            await tasks.updateRecordAsync(recordId, { Notes: 'seen by script' });
            const logId = await base.getTable('Log').createRecordAsync({ Name: 'Ran for ' + name });
            const found = await tasks.selectRecordsAsync({
              filter: { conditions: [{ field: 'Name', operator: 'is', value: 'Older' }] },
            });
            const res = await fetch('http://127.0.0.1:${port}/hello?x=1', { method: 'POST', body: 'hi' });
            output.set('summary', name + ': ' + query.records.map((r) => r.getCellValue('Name')).join(','));
            output.set('logId', logId);
            output.set('found', found.records.length);
            output.set('fetched', { status: res.status, body: await res.json(), echo: res.headers.get('X-Echo') });
          `,
        },
        {
          type: 'createRecord',
          tableId: log.table.id,
          fields: { [log.name]: '{{steps.1.output.summary}}' },
        },
      ]);
      const record = await addRecord(tasks, { [tasks.name]: 'Newer' });
      const run = await test(auto.id, record.id);
      expect(run.error).toBeNull();
      expect(run.status).toBe('succeeded');
      const out = run.steps[0]?.output;
      expect(out.output).toMatchObject({
        summary: 'Newer: Newer,Older',
        found: 1,
        fetched: { status: 200, body: { path: '/hello?x=1' }, echo: 'POST' },
      });
      expect(out.logs).toEqual([{ level: 'log', text: 'records 2' }]);
      // The log keeps the inputs, not the script.
      expect(run.steps[0]?.input).toEqual({
        type: 'runScript',
        inputs: { recordId: record.id, name: 'Newer' },
      });
      expect((await rowsOf(tasks)).find((r) => r.id === record.id)?.notes).toBe('seen by script');
      expect((await rowsOf(log)).map((r) => r.name).sort()).toEqual([
        'Newer: Newer,Older',
        'Ran for Newer',
      ]);
    });

    it('runs in the worker as the creator, and refused URLs and other bases stay out', async () => {
      const m = await makeTable('Worker');
      const elsewhere = await makeTable('Elsewhere', other);
      const auto = await automation(m, [
        {
          type: 'runScript',
          inputs: { id: '{{trigger.record.id}}' },
          script: `
            const errors = {};
            for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:${port}/', 'file:///etc/passwd']) {
              try { await fetch(url); errors[url] = 'fetched'; } catch (e) { errors[url] = e.message; }
            }
            try { base.getTable('${elsewhere.table.id}'); } catch (e) { errors.table = e.message; }
            output.set('errors', errors);
            await base.getTable('Worker').updateRecordAsync(input.config().id, { Notes: 'worker' });
          `,
        },
      ]);
      await call(creator, 'PATCH', `${autos()}/${auto.id}`, { enabled: true });
      const record = await addRecord(m, { [m.name]: 'r' });
      const { rows } = await t.db.execute<{ id: number }>(
        sql`SELECT id FROM outbox WHERE kind = 'record.created' AND payload->>'recordId' = ${record.id}`
      );
      const outcome = await runAutomationJob(
        {
          db: t.appDb,
          logger,
          scripts,
          outbound: {
            cipher: createCipher(encryptionKey, 'automation-secret'),
            http: createSafeFetch(
              outboundPolicy({ allowHttp: true, extraPorts: [port], allow: [], deny: [] })
            ),
            email: memoryTransport(),
            emailDailyLimit: 0,
          },
        },
        { workspaceId, subscriberId: auto.id, outboxId: Number(rows[0]?.id) }
      );
      expect(outcome).toMatchObject({ status: 'succeeded' });
      const runs = await call(creator, 'GET', `${autos()}/${auto.id}/runs`);
      const errors = runs.body.runs[0].steps[0].output.output.errors as Record<string, string>;
      for (const message of Object.values(errors)) expect(message).not.toBe('fetched');
      expect(errors['table']).toMatch(/No table/);
      expect((await rowsOf(m))[0]?.notes).toBe('worker');
      // Its write's event carries the run's depth (the loop guard).
      const events = await t.db.execute<{ depth: number }>(
        sql`SELECT automation_depth AS depth FROM outbox WHERE kind = 'record.updated' AND payload->>'recordId' = ${record.id}`
      );
      expect(events.rows.map((e) => e.depth)).toContain(1);
    });

    it("refuses another base's table ids in calls", async () => {
      const elsewhere = await makeTable('Far', other);
      const answer = await inScope(t.appDb, { userId: creator.id, workspaceId }, (tx) => {
        const bridge = createScriptBridge({
          tx,
          automationId: '01900000-0000-7000-8000-0000000000aa',
          workspaceId,
          entitlements: unlimitedEntitlements(),
          baseId: base.id,
          userId: creator.id,
          role: 'creator',
          http: undefined,
          describe: () => null,
        });
        return bridge('select', { tableId: elsewhere.table.id }).catch((e: Error) => e.message);
      });
      expect(answer).toBe('No such table in this base.');
    });

    it('runs as the tester: edit permissions apply, and a failed script rolls its writes back', async () => {
      const m = await makeTable('Guarded');
      // Only owners may edit Notes.
      await t.db
        .update(fields)
        .set({ permissions: { edit: { level: 'specific', userIds: [], roles: ['owner'] } } })
        .where(sql`${fields.id} = ${m.notes}`);
      const auto = await automation(m, [
        {
          type: 'runScript',
          inputs: { id: '{{trigger.record.id}}' },
          script: `
            const t = base.getTable('Guarded');
            let caught = null;
            try { await t.updateRecordAsync(input.config().id, { Notes: 'nope' }); }
            catch (e) { caught = e.message; }
            console.log('caught', caught);
            await t.createRecordAsync({ Name: 'made before the failure' });
            await t.updateRecordAsync(input.config().id, { Notes: 'nope' });
          `,
        },
      ]);
      const record = await addRecord(m, { [m.name]: 'r' });
      const run = await test(auto.id, record.id);
      expect(run.status).toBe('failed');
      expect(run.steps[0]?.error).toMatch(/Notes|edit/i);
      expect(run.steps[0]?.output.logs[0].text).toMatch(/^caught .*(Notes|edit)/i);
      const rows = await rowsOf(m);
      expect(rows.map((r) => r.name)).toEqual(['r']);
      expect(rows[0]?.notes).toBeNull();
    });
  });
});
