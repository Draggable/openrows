import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DISCORD_WEBHOOK_HOSTS, MAX_RUN_EXTERNAL_ACTIONS, REDACTED } from '@openrows/shared';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import type { OutboundDeps } from '../../src/automations/outbound.js';
import { runAutomationJob } from '../../src/automations/run.js';
import { readSecrets } from '../../src/automations/secrets.js';
import { automations, type bases, type users } from '../../src/db/index.js';
import { memoryTransport } from '../../src/email/transport.js';
import { createLogger } from '../../src/lib/logger.js';
import {
  createSafeFetch,
  outboundPolicy,
  type ResolvedAddress,
  type SafeFetch,
} from '../../src/lib/safe-fetch/index.js';
import { createTable } from '../../src/tables/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createBase, createSession, createWorkspace } from '../helpers/factories.js';

type User = typeof users.$inferSelect;
type Base = typeof bases.$inferSelect;
type Json = ReturnType<typeof JSON.parse>;

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Step {
  type: string;
  status: string;
  error: string | null;
  input: Json;
  output: Json;
  then?: Step[];
  iterations?: { index: number; status: string; steps: Step[] }[];
}
interface Run {
  id: string;
  status: string;
  mode: string;
  error: string | null;
  steps: Step[];
}

const ID = '112233445566778899';
const TOKEN = 'dIsCoRdToKeN_secret-value-0123456789';
const HOOK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
const HOOK_PATH = `/api/webhooks/${ID}/${TOKEN}`;

/**
 * The Send Discord message action as openrows_app: the URL on Discord's hosts only (422 on its
 * path, nested too), encrypted at rest and redacted in the API, run history and test runs; the
 * message's JSON with `allowed_mentions`, sent through the SSRF-safe client (which still refuses
 * a Discord name resolving to a private or metadata address); non-2xx answers fail the step; and
 * the step counts toward the run's external steps inside a repeat.
 *
 * Nothing here reaches Discord: the app resolves Discord's hosts to 127.0.0.1 (allowlisted) when
 * it checks a saved URL, and the worker's client used here sends `https://<discord host>/…` to
 * the local test server through the real safe client with the same rules.
 */
describe('Send Discord message', () => {
  const t = useTestDb();
  const logger = createLogger({ level: 'silent' });
  let app: ReturnType<typeof testApp>['app'];
  let config: ReturnType<typeof testApp>['config'];
  let owner: User;
  let creator: User;
  let cookies: Map<string, string>;
  let workspaceId: string;
  let base: Base;
  let server: Server;
  let port: number;
  const received: Received[] = [];
  /** The local server's answer to Discord paths (other paths: 200). */
  let answer = 204;
  let outbound: OutboundDeps;
  let safe: SafeFetch;

  /** Discord's hosts at 127.0.0.1; no other name resolves (no test touches the network). */
  const resolveLocal = async (hostname: string): Promise<ResolvedAddress[]> => {
    if ((DISCORD_WEBHOOK_HOSTS as readonly string[]).includes(hostname)) {
      return [{ address: '127.0.0.1', family: 4 }];
    }
    throw new Error(`no DNS in this test: ${hostname}`);
  };
  /** The worker's client: Discord URLs to the local server, through the safe client. */
  const toLocal: SafeFetch = (url, init) => {
    const local = String(url).replace(
      /^https:\/\/(?:discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\//,
      `http://127.0.0.1:${port}/`
    );
    return safe(local, init);
  };

  const call = async (
    who: User | null,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: Json }> => {
    const headers = new Headers();
    if (who) headers.set('cookie', `${SESSION_COOKIE}=${cookies.get(who.id)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const autos = () => `/api/bases/${base.id}/automations`;
  const create = async (actions: unknown[]) => {
    const res = await call(creator, 'POST', autos(), {
      name: 'Discord',
      enabled: true,
      trigger: { type: 'webhookReceived' },
      actions,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; webhookUrl: string; actions: Json[] };
  };
  const refused = async (actions: unknown[]) => {
    const res = await call(creator, 'POST', autos(), {
      name: 'Bad',
      trigger: { type: 'webhookReceived' },
      actions,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    return (res.body.errors ?? []) as { path: string; message: string }[];
  };
  /** Runs a webhook-received automation with this body, as the worker would. */
  const fire = (id: string, body: unknown, deps: Partial<OutboundDeps> = {}) =>
    runAutomationJob(
      { db: t.appDb, logger, outbound: { ...outbound, ...deps } },
      {
        workspaceId,
        subscriberId: id,
        hook: { requestId: uuidv7(), receivedAt: new Date().toISOString(), body },
      }
    );
  /** Runs the automation jobs the app sent (requests to webhook URLs). */
  const seen = new Set<string>();
  const runSent = async () => {
    const { rows } = await t.db.execute<{ id: string; data: unknown }>(
      sql`SELECT id, data FROM pgboss.job WHERE name = 'automations.run' ORDER BY created_on`
    );
    for (const job of rows) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      await runAutomationJob({ db: t.appDb, logger, outbound }, job.data);
    }
  };
  const runs = async (id: string): Promise<Run[]> => {
    const res = await call(creator, 'GET', `${autos()}/${id}/runs?limit=100`);
    expect(res.status).toBe(200);
    return res.body.runs as Run[];
  };
  const lastRun = async (id: string) => {
    const [run] = await runs(id);
    if (!run) throw new Error('no run');
    return run;
  };
  const off = (id: string) => call(creator, 'PATCH', `${autos()}/${id}`, { enabled: false });
  const discord = (over: Record<string, unknown> = {}) => ({
    type: 'discordMessage',
    webhookUrl: HOOK,
    text: 'Hi',
    ...over,
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (!req.url?.startsWith('/api/webhooks/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        }
        if (answer === 429) res.setHeader('retry-after', '1');
        // Somewhere the safe client itself would reach (allowlisted), but not Discord.
        if (answer === 307) res.setHeader('location', `http://127.0.0.1:${port}/elsewhere`);
        res.writeHead(answer, answer === 204 ? {} : { 'content-type': 'application/json' });
        res.end(answer === 204 ? undefined : '{"message":"nope"}');
      });
    });
    port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    );
    const built = testApp({
      db: t.appDb,
      env: {
        OUTBOUND_HTTP_ALLOW_HTTP: 'true',
        OUTBOUND_HTTP_PORTS: String(port),
        OUTBOUND_HTTP_ALLOW: '127.0.0.1',
      },
      automationResolve: resolveLocal,
    });
    app = built.app;
    config = built.config;
    safe = createSafeFetch(
      outboundPolicy({ allowHttp: true, extraPorts: [port], allow: ['127.0.0.1'], deny: [] })
    );
    outbound = {
      cipher: createCipher(config.encryptionKey, 'automation-secret'),
      http: toLocal,
      email: memoryTransport(),
      emailDailyLimit: 100,
    };
    const w = await createWorkspace(t.db);
    owner = w.owner;
    workspaceId = w.workspace.id;
    creator = await addMember(t.db, workspaceId, 'creator');
    cookies = new Map([[creator.id, await createSession(t.db, creator)]]);
    base = await createBase(t.db, workspaceId, { name: 'Discord' });
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('posts the message with allowed_mentions through the safe client; later steps see the status', async () => {
    received.length = 0;
    const a = await create([
      discord({
        text: 'Order {{trigger.body.order}} for @everyone and <@&123>',
        username: 'Orders {{trigger.body.order}}',
        embed: {
          title: 'Order {{trigger.body.order}}',
          description: 'Total: {{trigger.body.total}}',
          url: '{{trigger.body.link}}',
          color: '#5865F2',
        },
      }),
      {
        type: 'httpRequest',
        method: 'POST',
        url: `http://127.0.0.1:${port}/after`,
        headers: [],
        body: { status: '{{steps.1.status}}' },
      },
    ]);
    await fire(a.id, { order: 'A-17', total: 42, link: 'https://example.com/orders/A-17' });
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ method: 'POST', url: HOOK_PATH });
    expect(received[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(received[0]?.body ?? '')).toEqual({
      content: 'Order A-17 for @everyone and <@&123>',
      username: 'Orders A-17',
      embeds: [
        {
          title: 'Order A-17',
          description: 'Total: 42',
          url: 'https://example.com/orders/A-17',
          color: 0x5865f2,
        },
      ],
      allowed_mentions: { parse: [] },
    });
    expect(JSON.parse(received[1]?.body ?? '')).toEqual({ status: 204 });
    const run = await lastRun(a.id);
    expect(run.status, run.error ?? '').toBe('succeeded');
    expect(run.steps[0]?.output).toEqual({ status: 204 });
    await off(a.id);
  });

  it('notifies only whom the step allows, and cuts long filled-in text to 2,000 characters', async () => {
    received.length = 0;
    const a = await create([
      discord({ text: '{{trigger.body.text}}', mentions: ['everyone', 'roles'] }),
    ]);
    await fire(a.id, { text: 'x'.repeat(5000) });
    const sent = JSON.parse(received[0]?.body ?? '');
    expect(sent.allowed_mentions).toEqual({ parse: ['roles', 'everyone'] });
    expect(sent.content).toHaveLength(2000);
    expect(sent.content.endsWith('…')).toBe(true);
    expect((await lastRun(a.id)).status).toBe('succeeded');

    // Filled in empty with no embed: the step fails without a request.
    received.length = 0;
    await fire(a.id, { text: '   ' });
    const run = await lastRun(a.id);
    expect(run.status).toBe('failed');
    expect(run.steps[0]?.error).toBe('The message is empty once its values are filled in.');
    expect(received).toEqual([]);
    await off(a.id);
  });

  it('keeps the URL encrypted at rest and redacted in the API, run history, test runs and the template export', async () => {
    received.length = 0;
    const a = await create([discord({ text: 'Order {{trigger.body.order}}' })]);
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    expect(a.actions[0]).toEqual({
      type: 'discordMessage',
      text: 'Order {{trigger.body.order}}',
      mentions: [],
    });
    const [row] = await t.db.select().from(automations).where(eq(automations.id, a.id));
    expect(JSON.stringify(row?.actions)).not.toContain(TOKEN);
    expect(row?.secretsEncrypted).not.toBeNull();
    expect(row?.secretsEncrypted?.toString('utf8') ?? '').not.toContain(TOKEN);
    expect(readSecrets(outbound.cipher, row?.secretsEncrypted)).toEqual([{ webhookUrl: HOOK }]);

    const listed = await call(creator, 'GET', autos());
    expect(JSON.stringify(listed.body)).not.toContain(TOKEN);
    const one = await call(creator, 'GET', `${autos()}/${a.id}`);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).not.toContain(TOKEN);

    // A live run through the webhook URL: the log keeps the text, never the URL.
    expect(
      (await call(null, 'POST', new URL(a.webhookUrl).pathname, { order: 'B-2' })).status
    ).toBe(200);
    await runSent();
    expect(received.map((r) => r.url)).toEqual([HOOK_PATH]);
    const run = await lastRun(a.id);
    expect(run.status).toBe('succeeded');
    expect(run.steps[0]?.input).toEqual({
      type: 'discordMessage',
      text: 'Order B-2',
      mentions: [],
      webhookUrl: REDACTED,
    });
    expect(JSON.stringify(await runs(a.id))).not.toContain(TOKEN);

    // A test run in the request (the app's own client) logs it redacted too.
    const tested = await call(creator, 'POST', `${autos()}/${a.id}/test`, {});
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body.mode).toBe('test');
    expect(tested.body.steps[0].input.webhookUrl).toBe(REDACTED);
    expect(JSON.stringify(tested.body)).not.toContain(TOKEN);
    expect(JSON.stringify(await runs(a.id))).not.toContain(TOKEN);

    // "Save as template" carries the step without its URL (a template needs a table).
    await inScope(t.appDb, { userId: owner.id, workspaceId }, (tx) =>
      createTable({ tx, workspaceId, userId: owner.id }, base, { name: 'Orders' })
    );
    const exported = await call(creator, 'GET', `/api/bases/${base.id}/template.json`);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).not.toContain(TOKEN);
    expect(JSON.stringify(exported.body)).toContain('discordMessage');

    // Saved back as read, the URL is kept; a new one replaces it.
    const kept = await call(creator, 'PATCH', `${autos()}/${a.id}`, { actions: a.actions });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    received.length = 0;
    await fire(a.id, { order: 'C-3' });
    expect(received.map((r) => r.url)).toEqual([HOOK_PATH]);
    const other = `https://canary.discord.com/api/v10/webhooks/42/other-token`;
    const moved = await call(creator, 'PATCH', `${autos()}/${a.id}`, {
      actions: [{ ...a.actions[0], webhookUrl: other }],
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    received.length = 0;
    await fire(a.id, { order: 'D-4' });
    expect(received.map((r) => r.url)).toEqual(['/api/v10/webhooks/42/other-token']);
    await off(a.id);
  });

  it('keeps a URL per nested step and sends each to its own webhook', async () => {
    received.length = 0;
    const second = `https://discordapp.com/api/webhooks/${ID}/nested-token`;
    const a = await create([
      {
        type: 'repeat',
        items: '{{trigger.body.list}}',
        actions: [
          discord({ text: 'Item {{steps.1.item}}' }),
          discord({ webhookUrl: second, text: '#{{steps.1.index}}' }),
        ],
      },
    ]);
    const [row] = await t.db.select().from(automations).where(eq(automations.id, a.id));
    expect(JSON.stringify(row?.actions)).not.toContain('nested-token');
    expect(readSecrets(outbound.cipher, row?.secretsEncrypted)).toEqual([
      { actions: [{ webhookUrl: HOOK }, { webhookUrl: second }] },
    ]);
    await fire(a.id, { list: ['a', 'b'] });
    expect(received.map((r) => [r.url, JSON.parse(r.body).content])).toEqual([
      [HOOK_PATH, 'Item a'],
      [`/api/webhooks/${ID}/nested-token`, '#1'],
      [HOOK_PATH, 'Item b'],
      [`/api/webhooks/${ID}/nested-token`, '#2'],
    ]);
    const run = await lastRun(a.id);
    expect(run.status).toBe('succeeded');
    expect(JSON.stringify(run)).not.toContain('nested-token');
    expect(JSON.stringify(run)).not.toContain(TOKEN);

    // Saved back without the URLs (as read), both are kept.
    const kept = await call(creator, 'PATCH', `${autos()}/${a.id}`, { actions: a.actions });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const [after] = await t.db.select().from(automations).where(eq(automations.id, a.id));
    expect(readSecrets(outbound.cipher, after?.secretsEncrypted)).toEqual([
      { actions: [{ webhookUrl: HOOK }, { webhookUrl: second }] },
    ]);
    await off(a.id);
  });

  it('refuses URLs off Discord at save with a 422 on the step’s path, nested ones too', async () => {
    for (const url of [
      'http://discord.com/api/webhooks/1/token',
      'https://discord.com.evil.example/api/webhooks/1/token',
      'https://162.159.135.232/api/webhooks/1/token',
      `http://127.0.0.1:${port}/api/webhooks/1/token`,
      'https://hooks.slack.com/services/T0/B0/x',
      'https://discord.com/api/v10/channels/1/messages',
      'https://discord.com/api/webhooks/{{trigger.body.id}}/token',
    ]) {
      const errors = await refused([discord({ webhookUrl: url })]);
      expect(
        errors.map((e) => e.path),
        url
      ).toEqual(['actions.0.webhookUrl']);
      expect(errors[0]?.message).toContain('Discord webhook URL');
    }
    const nested = await refused([
      {
        type: 'branch',
        tableId: uuidv7(),
        recordId: '{{trigger.body.id}}',
        filter: { conjunction: 'and', conditions: [] },
        // biome-ignore lint/suspicious/noThenProperty: a list of steps (an array, never a function)
        then: [discord({ webhookUrl: 'https://discord.com.evil.example/api/webhooks/1/t' })],
        otherwise: [
          {
            type: 'repeat',
            items: '{{trigger.body.list}}',
            actions: [discord(), discord({ webhookUrl: 'http://discord.com/api/webhooks/1/t' })],
          },
        ],
      },
    ]);
    expect(nested.map((e) => e.path).sort()).toEqual([
      'actions.0.otherwise.0.actions.1.webhookUrl',
      'actions.0.then.0.webhookUrl',
    ]);
  });

  it('needs a URL, and a message or an embed', async () => {
    const missing = await refused([
      {
        type: 'repeat',
        items: '{{trigger.body.list}}',
        actions: [{ type: 'discordMessage', text: 'x' }],
      },
    ]);
    expect(missing).toEqual([
      { path: 'actions.0.actions.0.webhookUrl', message: 'Enter the Discord webhook URL.' },
    ]);
    expect(await refused([discord({ text: '' })])).toEqual([
      { path: 'actions.0.text', message: 'Write a message or add an embed.' },
    ]);
    expect(await refused([discord({ text: 'x'.repeat(2001) })])).toMatchObject([
      { path: 'actions.0.text' },
    ]);

    // A Slack step's URL never carries over to a Discord step in its place.
    const slack = await create([
      { type: 'slackMessage', webhookUrl: `http://127.0.0.1:${port}/slack`, text: 'x' },
    ]);
    const swapped = await call(creator, 'PATCH', `${autos()}/${slack.id}`, {
      actions: [{ type: 'discordMessage', text: 'x' }],
    });
    expect(swapped.status).toBe(422);
    expect(swapped.body.errors).toEqual([
      { path: 'actions.0.webhookUrl', message: 'Enter the Discord webhook URL.' },
    ]);
    await off(slack.id);
  });

  it('refuses a Discord name that resolves to a private, internal or metadata address', async () => {
    received.length = 0;
    const a = await create([discord()]);
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fd00:ec2::254']) {
      // The worker's rules with nothing allowlisted, and DNS pointing Discord's name inward.
      const inward = createSafeFetch(
        outboundPolicy({ allowHttp: false, extraPorts: [], allow: [], deny: [] }),
        { resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }] }
      );
      await fire(a.id, {}, { http: inward });
      const run = await lastRun(a.id);
      expect(run.status, address).toBe('failed');
      expect(run.steps[0]?.error).toMatch(/^The request failed: .*private or reserved address/);
      expect(run.steps[0]?.error).not.toContain(TOKEN);
    }
    expect(received).toEqual([]);
    await off(a.id);

    // At save too: the app's rules with Discord's name at the metadata address.
    const metadata = testApp({
      db: t.appDb,
      automationResolve: async () => [{ address: '169.254.169.254', family: 4 }],
    }).app;
    const res = await metadata.request(autos(), {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${cookies.get(creator.id)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'X',
        trigger: { type: 'webhookReceived' },
        actions: [discord()],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: unknown };
    expect(body.errors).toEqual([
      {
        path: 'actions.0.webhookUrl',
        message: expect.stringMatching(/^This URL can't be used: .*private or reserved address/),
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('fails the step on a non-2xx answer with its status, without retrying a 429', async () => {
    const a = await create([
      discord(),
      { type: 'httpRequest', method: 'GET', url: `http://127.0.0.1:${port}/after`, headers: [] },
    ]);
    for (const status of [400, 429, 500]) {
      answer = status;
      received.length = 0;
      await fire(a.id, {});
      const run = await lastRun(a.id);
      expect(run.status).toBe('failed');
      expect(run.steps[0]?.error).toMatch(new RegExp(`^Discord answered ${status}\\b`));
      expect(run.error).toMatch(new RegExp(`^Step 1 failed: Discord answered ${status}\\b`));
      expect(run.steps[1]?.status).toBe('skipped');
      // One request: no retries, and the step after it never ran.
      expect(received.map((r) => r.url)).toEqual([HOOK_PATH]);
    }
    answer = 204;
    await off(a.id);
  });

  it("doesn't follow a redirect off Discord's hosts: the message isn't sent on", async () => {
    const a = await create([discord({ text: 'Not for elsewhere' })]);
    answer = 307;
    received.length = 0;
    await fire(a.id, {});
    const run = await lastRun(a.id);
    expect(run.status).toBe('failed');
    expect(run.steps[0]?.error).toBe(
      "The server answered with a redirect; redirects aren't followed."
    );
    expect(received.map((r) => r.url)).toEqual([HOOK_PATH]);
    expect(JSON.stringify(run)).not.toContain(TOKEN);
    answer = 204;
    await off(a.id);
  });

  it(`counts toward the run's ${MAX_RUN_EXTERNAL_ACTIONS} external steps inside a repeat`, async () => {
    received.length = 0;
    const a = await create([
      {
        type: 'repeat',
        items: '{{trigger.body.list}}',
        actions: [discord({ text: '{{steps.1.item}}' })],
      },
    ]);
    const list = Array.from({ length: MAX_RUN_EXTERNAL_ACTIONS + 5 }, (_, i) => `n${i + 1}`);
    await fire(a.id, { list });
    const run = await lastRun(a.id);
    expect(run.status).toBe('failed');
    expect(run.error).toBe(
      `Item ${MAX_RUN_EXTERNAL_ACTIONS + 1}: Step 1.actions.1 failed: This run reached its limit of ${MAX_RUN_EXTERNAL_ACTIONS} external steps (HTTP requests, Slack and Discord messages, emails and scripts); the rest weren't run.`
    );
    expect(received).toHaveLength(MAX_RUN_EXTERNAL_ACTIONS);
    expect(JSON.parse(received.at(-1)?.body ?? '').content).toBe(`n${MAX_RUN_EXTERNAL_ACTIONS}`);
    await off(a.id);
  });
});
