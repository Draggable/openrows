import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { memoryTransport } from '../../src/email/transport.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { createSession, createToken, createUser, createWorkspace } from '../helpers/factories.js';

const ORIGIN = 'http://localhost:5173';

/**
 * The access log: every request through the real app, with real sessions, a personal
 * access token and an invitation, leaves one line per request with the method, the redacted path
 * and the status, and never a cookie, a bearer token or an invitation secret.
 */
describe('access log (#75)', () => {
  const t = useTestDb();

  it('never contains session cookies, access tokens or invitation secrets', async () => {
    const { workspace, owner } = await createWorkspace(t.db, { name: 'Acme' });
    const invitee = await createUser(t.db);
    const email = memoryTransport();
    const { app, logs } = testApp({ db: t.appDb, email });
    const ownerCookie = await createSession(t.db, owner);
    const inviteeCookie = await createSession(t.db, invitee);
    const { token: pat } = await createToken(t.db, owner, { workspaceIds: [workspace.id] });
    const as = (cookie: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('cookie', `${SESSION_COOKIE}=${cookie}`);
      headers.set('origin', ORIGIN);
      return { ...init, headers };
    };

    const invite = await app.request(
      `/api/workspaces/${workspace.id}/invitations`,
      as(ownerCookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: invitee.email, role: 'editor' }),
      })
    );
    expect(invite.status).toBe(201);
    const invitation = email.sent.at(-1)?.text.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1];
    if (!invitation) throw new Error('no invitation link in the email');

    expect((await app.request(`/api/invitations/${invitation}`, as(inviteeCookie))).status).toBe(
      200
    );
    const accept = await app.request(
      `/api/invitations/${invitation}/accept`,
      as(inviteeCookie, { method: 'POST' })
    );
    expect(accept.status).toBe(200);
    const v1 = await app.request('/api/v1/meta/bases', {
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(v1.status).toBe(200);
    const hook = 'hook_'.padEnd(43, 'z');
    expect(
      (
        await app.request(`/hooks/a/${hook}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status
    ).toBe(404);
    await app.request(`/email/unsubscribe?token=${hook}`);

    const lines = logs.filter((l) => l['msg'] === 'request completed');
    expect(lines.map((l) => l['path'])).toEqual(
      expect.arrayContaining([
        '/api/invitations/:token',
        '/api/invitations/:token/accept',
        '/hooks/a/:token',
        '/email/unsubscribe',
      ])
    );
    const all = JSON.stringify(logs);
    for (const secret of [
      ownerCookie,
      inviteeCookie,
      pat,
      pat.split('_').at(-1),
      invitation,
      hook,
    ]) {
      expect(all).not.toContain(secret);
    }
  });
});
