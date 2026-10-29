import type { AiSettings, AiTestResult, WorkspaceUsage } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  completion,
  type FakeOpenAi,
  fakeOutbound,
  startFakeOpenAi,
} from '../../src/ai/__fixtures__/fake-openai.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { Edition, ManagedAi } from '../../src/edition/types.js';
import { memoryTransport } from '../../src/email/transport.js';
import { checkUsageWarnings } from '../../src/usage/warnings.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';
import { planEdition } from '../helpers/plans.js';

/**
 * Hosted AI credits end to end against real Postgres and a fake OpenAI-compatible server
 * at `/api` (Open WebUI's path, as the hosted model server serves it): the edition's provider with its platform
 * key and per-plan model, credits counted per request (1 per 2,000 tokens started), shown on the
 * Usage page and in Settings → AI, warned about at 80% and 100%, and a soft block at the limit
 * that a workspace's own key doesn't hit. No test calls a real model server.
 */
const t = useTestDb();
const PLATFORM_KEY = 'sk-platform-HOSTEDKEY-0123456789abcdef';
const OWN_KEY = 'sk-own-WORKSPACEKEY-0123456789abcdef';
const ENCRYPTION_KEY = 'ai-credits-encryption-key-0123456789abcdef';

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi('/api');
});
afterAll(() => fake.close());
beforeEach(() => {
  fake.requests.length = 0;
  fake.respond = () =>
    completion('{"ok":true}', {
      usage: { prompt_tokens: 3000, completion_tokens: 1500, total_tokens: 4500 },
    });
});

function setup(ai: ManagedAi | null = managed()) {
  const plans = planEdition();
  const edition: Edition = { ...plans.edition, ai };
  const app = testApp({
    db: t.appDb,
    edition,
    config: {
      encryptionKey: ENCRYPTION_KEY,
      outbound: fakeOutbound(fake.port),
      // The instance's AI_* provider is not used when the edition brings its own (or none).
      ai: {
        instance: { baseUrl: 'http://127.0.0.1:1/v1', model: 'ignored', apiKey: 'sk-ignored-0000' },
        allowedHosts: undefined,
        timeoutMs: 10_000,
      },
    },
  });
  const request = async (method: string, path: string, cookie: string, body?: unknown) =>
    app.app.request(path, {
      method,
      headers: {
        origin: app.config.appUrl,
        cookie: `${SESSION_COOKIE}=${cookie}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { app, plans, request };
}

function managed(): ManagedAi {
  return {
    id: 'hosted',
    baseUrl: fake.baseUrl,
    apiKey: PLATFORM_KEY,
    modelFor: (plan) => (plan === 'business' ? 'big-model' : 'small-model'),
  };
}

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

async function tenant() {
  const { workspace, owner } = await createWorkspace(t.db, { name: 'Acme' });
  const editor = await addMember(t.db, workspace.id, 'editor');
  return {
    workspaceId: workspace.id,
    owner: await createSession(t.db, owner),
    ownerEmail: owner.email,
    editor: await createSession(t.db, editor),
  };
}

async function counted(workspaceId: string) {
  const { rows } = await t.db.execute<{ credits: string; requests: string; tokens: string }>(sql`
    SELECT credits, requests, tokens FROM ai_credit_counts WHERE workspace_id = ${workspaceId}::uuid`);
  const row = rows[0];
  return row
    ? { credits: Number(row.credits), requests: Number(row.requests), tokens: Number(row.tokens) }
    : null;
}

describe('hosted AI credits (#151)', () => {
  it('runs on the platform key with the plan’s model and counts credits per request', async () => {
    const { app, plans, request } = setup();
    const w = await tenant();
    plans.set(w.workspaceId, { limits: { aiCreditsPerMonth: 100 } });
    const path = `/api/workspaces/${w.workspaceId}/ai`;

    const settings = await ok<AiSettings>(request('GET', `${path}/settings`, w.owner));
    expect(settings).toMatchObject({
      source: 'instance',
      instance: {
        available: true,
        model: 'small-model',
        credits: { used: 0, limit: 100, resetsOn: expect.any(String) },
      },
    });
    expect(JSON.stringify(settings)).not.toContain(fake.baseUrl);

    const tested = await ok<AiTestResult>(request('POST', `${path}/settings/test`, w.owner));
    expect(tested).toMatchObject({ ok: true, source: 'instance' });
    expect(fake.requests[0]?.path).toBe('/api/chat/completions');
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(fake.requests[0]?.body['model']).toBe('small-model');
    // 4,500 tokens: 3 credits (1 per 2,000 started).
    expect(await counted(w.workspaceId)).toEqual({ credits: 3, requests: 1, tokens: 4500 });

    // The Usage page: this month's credits against the plan's.
    const usage = await ok<WorkspaceUsage>(
      request('GET', `/api/workspaces/${w.workspaceId}/usage`, w.editor)
    );
    expect(usage.aiCredits).toEqual({ used: 3, limit: 100 });

    expect(JSON.stringify(app.logs)).not.toContain(PLATFORM_KEY);
  });

  it('soft-blocks at the limit; a workspace’s own key keeps working and is never counted', async () => {
    const { plans, request } = setup();
    const w = await tenant();
    plans.set(w.workspaceId, { limits: { aiCreditsPerMonth: 3 } });
    const path = `/api/workspaces/${w.workspaceId}/ai`;

    // The request that crosses the limit finishes (a soft block): 3 of 3.
    expect(await ok<AiTestResult>(request('POST', `${path}/settings/test`, w.owner))).toMatchObject(
      { ok: true }
    );
    const blocked = await ok<AiTestResult>(request('POST', `${path}/settings/test`, w.owner));
    expect(blocked).toMatchObject({
      ok: false,
      error: expect.stringMatching(/used this month's 3 AI credits.*own API key/),
    });
    expect(fake.requests).toHaveLength(1);
    const settings = await ok<AiSettings>(request('GET', `${path}/settings`, w.owner));
    expect(settings.instance.credits).toMatchObject({ used: 3, limit: 3 });

    // Bring your own key: AI works again, on the workspace's account.
    await ok(
      request('PUT', `${path}/settings`, w.owner, {
        baseUrl: fake.baseUrl,
        model: 'own-model',
        apiKey: OWN_KEY,
      })
    );
    expect(await ok<AiTestResult>(request('POST', `${path}/settings/test`, w.owner))).toMatchObject(
      { ok: true, source: 'workspace' }
    );
    expect(fake.requests[1]?.headers.authorization).toBe(`Bearer ${OWN_KEY}`);
    expect(await counted(w.workspaceId)).toEqual({ credits: 3, requests: 1, tokens: 4500 });
  });

  it('emails the owners at 80% and at 100% of the month’s credits', async () => {
    const { plans, request } = setup();
    const w = await tenant();
    plans.set(w.workspaceId, { limits: { aiCreditsPerMonth: 4 } });
    const email = memoryTransport();
    const deps = {
      db: t.appDb,
      entitlements: plans.edition.entitlements,
      email,
      appUrl: 'http://localhost:5173',
      logger: { info: () => {}, warn: () => {} },
    };
    const path = `/api/workspaces/${w.workspaceId}/ai/settings/test`;

    await ok(request('POST', path, w.owner)); // 3 of 4: 75%
    expect(await checkUsageWarnings(deps, w.workspaceId)).toBe(0);
    fake.respond = () => completion('{"ok":true}'); // 17 tokens: 1 credit
    await ok(request('POST', path, w.owner)); // 4 of 4
    expect(await checkUsageWarnings(deps, w.workspaceId)).toBe(1);
    expect(email.sent[0]?.to).toBe(w.ownerEmail);
    expect(email.sent[0]?.text).toContain("This month's 4 AI credits are used up.");
    expect(await checkUsageWarnings(deps, w.workspaceId)).toBe(0);
  });

  it('without the platform key hosted AI is off: own keys only, no credits shown', async () => {
    const { request } = setup(null);
    const w = await tenant();
    const path = `/api/workspaces/${w.workspaceId}/ai`;
    const settings = await ok<AiSettings>(request('GET', `${path}/settings`, w.owner));
    expect(settings).toMatchObject({
      source: null,
      instance: { available: false, model: null, credits: null },
    });
    const usage = await ok<WorkspaceUsage>(
      request('GET', `/api/workspaces/${w.workspaceId}/usage`, w.owner)
    );
    expect(usage.aiCredits).toBeNull();
    const res = await request('POST', `${path}/settings/test`, w.owner);
    expect(res.status).toBe(409);
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps each workspace’s credits to itself (RLS)', async () => {
    const { plans, request } = setup();
    const a = await tenant();
    const b = await tenant();
    plans.set(a.workspaceId, { limits: { aiCreditsPerMonth: 10 } });
    plans.set(b.workspaceId, { limits: { aiCreditsPerMonth: 10 } });
    await ok(request('POST', `/api/workspaces/${a.workspaceId}/ai/settings/test`, a.owner));
    const usage = await ok<WorkspaceUsage>(
      request('GET', `/api/workspaces/${b.workspaceId}/usage`, b.owner)
    );
    expect(usage.aiCredits).toEqual({ used: 0, limit: 10 });
    // The app role can't write the counter directly, only through ai_credit_count.
    await expect(
      t.appDb.execute(
        sql`INSERT INTO ai_credit_counts (workspace_id, month, credits) VALUES (${a.workspaceId}::uuid, '2026-10-01', 0)`
      )
    ).rejects.toThrow();
  });
});
