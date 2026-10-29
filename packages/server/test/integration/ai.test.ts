import type { AiAvailability, AiSettings, AiTestResult } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  completion,
  type FakeOpenAi,
  fakeOutbound,
  startFakeOpenAi,
} from '../../src/ai/__fixtures__/fake-openai.js';
import { AiService } from '../../src/ai/service.js';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import type { AiConfig } from '../../src/config.js';
import { CountingUsageMeter, ossEdition, ossEntitlements } from '../../src/edition/index.js';
import type { Edition, UsageMeter } from '../../src/edition/types.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * AI providers with bring-your-own key, end to end against real Postgres and a fake
 * OpenAI-compatible server: owners store a workspace key (encrypted, write-only), test it, and
 * fall back to the instance's provider; no response and no log line ever carries a key.
 */
const t = useTestDb();
const KEY = 'sk-proj-WORKSPACEKEY-0123456789abcdef';
const INSTANCE_KEY = 'sk-instance-INSTANCEKEY-9876543210';
const ENCRYPTION_KEY = 'ai-test-encryption-key-0123456789abcdef';

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.requests.length = 0;
  fake.respond = () => completion('{"ok":true}');
});

describe('AI settings', () => {
  const everything: string[] = [];

  function setup(
    opts: {
      ai?: Partial<AiConfig>;
      outbound?: ReturnType<typeof fakeOutbound>;
      usage?: UsageMeter;
    } = {}
  ) {
    const edition: Edition = { ...ossEdition(), ...(opts.usage ? { usage: opts.usage } : {}) };
    const app = testApp({
      db: t.appDb,
      edition,
      config: {
        encryptionKey: ENCRYPTION_KEY,
        outbound: opts.outbound ?? fakeOutbound(fake.port),
        ai: { instance: undefined, allowedHosts: undefined, timeoutMs: 10_000, ...opts.ai },
      },
    });
    const request = async (method: string, path: string, cookie: string, body?: unknown) => {
      const res = await app.app.request(path, {
        method,
        headers: {
          origin: app.config.appUrl,
          cookie: `${SESSION_COOKIE}=${cookie}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      everything.push(await res.clone().text());
      return res;
    };
    return { app, edition, request };
  }

  async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
    const r = await res;
    if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  }

  async function tenant() {
    const { workspace, owner } = await createWorkspace(t.db);
    const editor = await addMember(t.db, workspace.id, 'editor');
    return {
      workspaceId: workspace.id,
      ownerId: owner.id,
      owner: await createSession(t.db, owner),
      editor: await createSession(t.db, editor),
    };
  }

  it('stores a workspace key encrypted and write-only, and uses it', async () => {
    const { app, request } = setup();
    const w = await tenant();
    const path = `/api/workspaces/${w.workspaceId}/ai`;

    expect(await ok<AiAvailability>(request('GET', path, w.editor))).toEqual({
      workspaceId: w.workspaceId,
      available: false,
      source: null,
    });
    const empty = await ok<AiSettings>(request('GET', `${path}/settings`, w.owner));
    expect(empty).toEqual({
      workspaceId: w.workspaceId,
      source: null,
      instance: { available: false, model: null, credits: null },
      workspace: null,
      allowedHosts: null,
    });

    const saved = await ok<AiSettings>(
      request('PUT', `${path}/settings`, w.owner, {
        baseUrl: `${fake.baseUrl}/`,
        model: 'fake-model',
        apiKey: KEY,
      })
    );
    expect(saved.source).toBe('workspace');
    expect(saved.workspace).toMatchObject({
      baseUrl: fake.baseUrl,
      model: 'fake-model',
      hasKey: true,
    });
    expect(JSON.stringify(saved)).not.toContain(KEY);

    // Encrypted at rest: neither the key nor a recognizable part of it is in the row.
    const { rows } = await t.db.execute<{ api_key_encrypted: Buffer }>(
      sql`SELECT api_key_encrypted FROM workspace_ai_settings WHERE workspace_id = ${w.workspaceId}`
    );
    const stored = rows[0]?.api_key_encrypted ?? Buffer.alloc(0);
    expect(stored.length).toBeGreaterThan(KEY.length);
    expect(stored.toString('latin1')).not.toContain('WORKSPACEKEY');
    expect(createCipher(ENCRYPTION_KEY, 'ai-key').decrypt(stored)).toBe(KEY);
    // Another purpose's key doesn't open it.
    expect(createCipher(ENCRYPTION_KEY, 'webhook-secret').decrypt(stored)).toBeUndefined();

    expect(await ok<AiAvailability>(request('GET', path, w.editor))).toMatchObject({
      available: true,
      source: 'workspace',
    });

    const tested = await ok<AiTestResult>(request('POST', `${path}/settings/test`, w.owner));
    expect(tested).toMatchObject({
      ok: true,
      source: 'workspace',
      model: 'fake-model-2026',
      error: null,
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(fake.requests[0]?.body).toMatchObject({
      model: 'fake-model',
      response_format: { type: 'json_schema', json_schema: { name: 'connection_test' } },
    });

    // The model alone changes without the key; the stored key goes on being used.
    const renamed = await ok<AiSettings>(
      request('PUT', `${path}/settings`, w.owner, { baseUrl: fake.baseUrl, model: 'other-model' })
    );
    expect(renamed.workspace?.model).toBe('other-model');
    await ok(request('POST', `${path}/settings/test`, w.owner));
    expect(fake.requests[1]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(fake.requests[1]?.body['model']).toBe('other-model');

    expect(app.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(app.logs)).not.toContain(KEY);
  });

  it('reports provider failures safely, without the key the provider echoed', async () => {
    const { app, request } = setup();
    const w = await tenant();
    const path = `/api/workspaces/${w.workspaceId}/ai/settings`;
    await ok(request('PUT', path, w.owner, { baseUrl: fake.baseUrl, model: 'm', apiKey: KEY }));
    fake.respond = () => ({
      status: 401,
      body: {
        error: {
          message: `Incorrect API key provided: ${KEY}. You can find your API key at …`,
          type: 'invalid_request_error',
          code: KEY,
        },
      },
    });
    const failed = await ok<AiTestResult>(request('POST', `${path}/test`, w.owner));
    expect(failed).toMatchObject({
      ok: false,
      source: 'workspace',
      error: 'The provider refused the API key.',
      usage: null,
    });
    const logs = JSON.stringify(app.logs);
    expect(logs).toContain('ai: request failed');
    expect(logs).toContain('status 401');
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain('Incorrect API key');

    // A model's answer that isn't the schema's shape.
    fake.respond = () => completion('{"ok":"yes"}');
    expect((await ok<AiTestResult>(request('POST', `${path}/test`, w.owner))).error).toMatch(
      /expected shape/
    );
  });

  it('checks what owners send', async () => {
    const { app, request } = setup();
    const w = await tenant();
    const path = `/api/workspaces/${w.workspaceId}/ai/settings`;
    // No stored key: one is needed.
    const noKey = await request('PUT', path, w.owner, { baseUrl: fake.baseUrl, model: 'm' });
    expect(noKey.status).toBe(422);
    // Malformed input; the rejected key isn't echoed back.
    for (const body of [
      { model: 'm', apiKey: `${KEY} with spaces` },
      { model: 'm', apiKey: 'short' },
      { model: '', apiKey: KEY },
      { model: 'm', apiKey: KEY, baseUrl: 'ftp://example.com' },
      { model: 'm', apiKey: KEY, baseUrl: `http://user:pw@127.0.0.1:${fake.port}/v1` },
      { model: 'm', apiKey: KEY, baseUrl: `${fake.baseUrl}?key=${KEY}` },
      { model: 'm', apiKey: KEY, extra: true },
    ]) {
      const res = await request('PUT', path, w.owner, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await res.text()).not.toContain('WORKSPACEKEY');
    }
    await ok(request('PUT', path, w.owner, { baseUrl: fake.baseUrl, model: 'm', apiKey: KEY }));
    // A stored key isn't pointed at another URL without being typed again.
    const moved = await request('PUT', path, w.owner, {
      baseUrl: `http://127.0.0.1:${fake.port}/other`,
      model: 'm',
    });
    expect(moved.status).toBe(422);
    expect(await moved.json()).toMatchObject({ errors: [{ path: 'apiKey' }] });
    expect(JSON.stringify(app.logs)).not.toContain('WORKSPACEKEY');
  });

  it('refuses base URLs the outbound rules or AI_ALLOWED_HOSTS refuse', async () => {
    const strict = setup({ outbound: { allowHttp: false, extraPorts: [], allow: [], deny: [] } });
    const w = await tenant();
    const path = `/api/workspaces/${w.workspaceId}/ai/settings`;
    for (const baseUrl of [
      fake.baseUrl,
      'https://127.0.0.1/v1',
      'https://169.254.169.254/latest',
      'https://10.0.0.5/v1',
    ]) {
      const res = await strict.request('PUT', path, w.owner, { baseUrl, model: 'm', apiKey: KEY });
      expect(res.status, baseUrl).toBe(422);
      expect(await res.json()).toMatchObject({ errors: [{ path: 'baseUrl' }] });
    }

    const hosted = setup({ ai: { allowedHosts: ['api.openai.com', '*.openrouter.ai'] } });
    const refused = await hosted.request('PUT', path, w.owner, {
      baseUrl: fake.baseUrl,
      model: 'm',
      apiKey: KEY,
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { detail: string }).detail).toContain(
      'api.openai.com, *.openrouter.ai'
    );
    expect((await ok<AiSettings>(hosted.request('GET', path, w.owner))).allowedHosts).toEqual([
      'api.openai.com',
      '*.openrouter.ai',
    ]);

    // A host dropped from the list after the key was saved is refused at request time.
    const open = setup();
    await ok(
      open.request('PUT', path, w.owner, { baseUrl: fake.baseUrl, model: 'm', apiKey: KEY })
    );
    const later = await ok<AiTestResult>(hosted.request('POST', `${path}/test`, w.owner));
    expect(later.ok).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it("falls back to the instance's provider, which is metered, and removes the key", async () => {
    const usage = new CountingUsageMeter();
    // No outbound allowlist: the operator's own URL is reachable anyway.
    const { app, request } = setup({
      usage,
      outbound: { allowHttp: false, extraPorts: [], allow: [], deny: [] },
      ai: { instance: { baseUrl: fake.baseUrl, model: 'instance-model', apiKey: INSTANCE_KEY } },
    });
    const w = await tenant();
    const path = `/api/workspaces/${w.workspaceId}/ai`;
    const settings = await ok<AiSettings>(request('GET', `${path}/settings`, w.owner));
    expect(settings).toMatchObject({
      source: 'instance',
      instance: { available: true, model: 'instance-model' },
      workspace: null,
    });
    expect(JSON.stringify(settings)).not.toContain(fake.baseUrl);
    expect(await ok<AiAvailability>(request('GET', path, w.editor))).toMatchObject({
      available: true,
      source: 'instance',
    });
    const tested = await ok<AiTestResult>(request('POST', `${path}/settings/test`, w.owner));
    expect(tested).toMatchObject({ ok: true, source: 'instance' });
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${INSTANCE_KEY}`);
    expect(fake.requests[0]?.body['model']).toBe('instance-model');
    expect(usage.used(w.workspaceId, 'aiCredits')).toBe(1);

    // A workspace key (on another URL the strict rules would refuse) takes over; removing it
    // goes back to the instance's.
    const open = setup({ usage });
    await ok(
      open.request('PUT', `${path}/settings`, w.owner, {
        baseUrl: fake.baseUrl,
        model: 'byo',
        apiKey: KEY,
      })
    );
    await ok(open.request('POST', `${path}/settings/test`, w.owner));
    expect(fake.requests[1]?.headers.authorization).toBe(`Bearer ${KEY}`);
    // A workspace's own key isn't metered.
    expect(usage.used(w.workspaceId, 'aiCredits')).toBe(1);
    const removed = await ok<AiSettings>(request('DELETE', `${path}/settings`, w.owner));
    expect(removed).toMatchObject({ source: 'instance', workspace: null });

    expect(JSON.stringify(app.logs)).not.toContain(INSTANCE_KEY);
    expect(JSON.stringify(app.logs)).not.toContain(KEY);
  });

  it("blocks the instance's provider when the meter says the credits are used up", async () => {
    const usage: UsageMeter = {
      id: 'exhausted',
      record: async () => {},
      check: async () => ({ allowed: false, metric: 'aiCredits', used: 1000, limit: 1000 }),
    };
    const { request } = setup({
      usage,
      ai: { instance: { baseUrl: fake.baseUrl, model: 'instance-model', apiKey: INSTANCE_KEY } },
    });
    const w = await tenant();
    const tested = await ok<AiTestResult>(
      request('POST', `/api/workspaces/${w.workspaceId}/ai/settings/test`, w.owner)
    );
    expect(tested).toMatchObject({ ok: false, error: expect.stringMatching(/credits/) });
    expect(fake.requests).toHaveLength(0);
  });

  it('without any provider, a test is a conflict; owners only; tests are rate-limited', async () => {
    const { request } = setup();
    const w = await tenant();
    const path = `/api/workspaces/${w.workspaceId}/ai/settings`;
    expect((await request('POST', `${path}/test`, w.owner)).status).toBe(409);
    expect((await request('GET', path, w.editor)).status).toBe(403);
    expect(
      (await request('PUT', path, w.editor, { baseUrl: fake.baseUrl, model: 'm', apiKey: KEY }))
        .status
    ).toBe(403);
    const other = await tenant();
    expect((await request('GET', path, other.owner)).status).toBe(404);

    await ok(request('PUT', path, w.owner, { baseUrl: fake.baseUrl, model: 'm', apiKey: KEY }));
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push((await request('POST', `${path}/test`, w.owner)).status);
    // A burst of 5 per workspace, the 409 above included.
    expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(statuses.at(-1)).toBe(429);
  });

  it('a workspace whose key no longer decrypts has AI off until the owner sets it again', async () => {
    const { request } = setup();
    const w = await tenant();
    const path = `/api/workspaces/${w.workspaceId}/ai/settings`;
    await ok(request('PUT', path, w.owner, { baseUrl: fake.baseUrl, model: 'm', apiKey: KEY }));
    const rotated = testApp({
      db: t.appDb,
      config: {
        encryptionKey: 'another-encryption-key-0123456789abcdef',
        outbound: fakeOutbound(fake.port),
      },
    });
    const service = new AiService({
      config: { instance: undefined, allowedHosts: undefined, timeoutMs: 5000 },
      outbound: fakeOutbound(fake.port),
      cipher: createCipher('another-encryption-key-0123456789abcdef', 'ai-key'),
      usage: new CountingUsageMeter(),
      entitlements: ossEntitlements,
      db: t.appDb,
      logger: rotated.logger,
    });
    const scope = { userId: w.ownerId, workspaceId: w.workspaceId };
    const resolved = await inScope(t.appDb, scope, (tx) => service.forWorkspace(tx, w.workspaceId));
    expect(resolved).toBeNull();
  });

  it('never sent a key in any response', () => {
    expect(everything.length).toBeGreaterThan(20);
    const all = everything.join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(INSTANCE_KEY);
  });
});
