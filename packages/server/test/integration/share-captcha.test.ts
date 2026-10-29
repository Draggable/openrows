import type { CreatedShare, TableMeta } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { createSession, createUser, createWorkspace } from '../helpers/factories.js';

/**
 * Turnstile on share-link password prompts: with Turnstile keys, the password prompt's
 * problem names the site key, and every password attempt needs a CAPTCHA token the verifier
 * accepts, checked before the password (no argon2 work for a refused attempt). Per-IP and
 * per-link attempt limits stay (shares.test.ts).
 */
describe('share password CAPTCHA', () => {
  const t = useTestDb();
  const checked: { token: string; remoteIp: string | undefined }[] = [];
  let app: ReturnType<typeof testApp>;
  let token: string;
  const password = 'a long enough password';

  beforeAll(async () => {
    app = testApp({
      db: t.appDb,
      config: { turnstile: { siteKey: 'site-key-133', secretKey: 'secret-133' } },
      captcha: async (input) => {
        checked.push({ token: input.token, remoteIp: input.remoteIp });
        return input.token === 'good-token';
      },
    });
    const { workspace, owner } = await createWorkspace(t.db, {
      owner: await createUser(t.db),
    });
    const cookie = await createSession(t.db, owner);
    const send = (method: string, path: string, body: unknown) =>
      app.app.request(path, {
        method,
        headers: {
          origin: app.config.appUrl,
          cookie: `${SESSION_COOKIE}=${cookie}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const base = (await (
      await send('POST', `/api/workspaces/${workspace.id}/bases`, { name: 'Base' })
    ).json()) as { id: string };
    const table = (await (
      await send('POST', `/api/bases/${base.id}/tables`, { name: 'Tasks' })
    ).json()) as TableMeta;
    const { rows } = await t.db.execute<{ id: string }>(
      sql`SELECT id FROM views WHERE table_id = ${table.id} ORDER BY position LIMIT 1`
    );
    const res = await send('POST', `/api/views/${rows[0]?.id}/shares`, { password });
    expect(res.status).toBe(201);
    token = ((await res.json()) as CreatedShare).token;
  });

  const unlock = (body: unknown) =>
    app.app.request(`/api/shared/${token}/unlock`, {
      method: 'POST',
      headers: { origin: app.config.appUrl, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const problem = async (res: Response) =>
    (await res.json()) as { code?: string; captchaSiteKey?: string };

  it('the password prompt names the site key', async () => {
    const res = await app.app.request(`/api/shared/${token}`, {
      headers: { origin: app.config.appUrl },
    });
    expect(res.status).toBe(401);
    expect(await problem(res)).toMatchObject({
      code: 'SHARE_PASSWORD_REQUIRED',
      captchaSiteKey: 'site-key-133',
    });
  });

  it('refuses an attempt without a token or with a bad one, before the password', async () => {
    checked.length = 0;
    const none = await unlock({ password });
    expect(none.status).toBe(403);
    expect(await problem(none)).toMatchObject({
      code: 'CAPTCHA_FAILED',
      captchaSiteKey: 'site-key-133',
    });
    expect(checked).toHaveLength(0);
    const bad = await unlock({ password, captchaToken: 'bad-token' });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('set-cookie')).toBeNull();
    expect(checked).toEqual([{ token: 'bad-token', remoteIp: expect.any(String) }]);
  });

  it('a good token with a wrong password is still a wrong password', async () => {
    const res = await unlock({ password: 'nope', captchaToken: 'good-token' });
    expect(res.status).toBe(401);
    expect(await problem(res)).toMatchObject({
      code: 'SHARE_PASSWORD_INCORRECT',
      captchaSiteKey: 'site-key-133',
    });
  });

  it('a good token and the right password unlock the link', async () => {
    const res = await unlock({ password, captchaToken: 'good-token' });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/^openrows_share=/);
  });

  it('caps the token size at the boundary', async () => {
    const res = await unlock({ password, captchaToken: 'x'.repeat(2049) });
    expect(res.status).toBe(422);
  });
});
