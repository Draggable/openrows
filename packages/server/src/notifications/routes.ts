import {
  BRAND,
  BRAND_COLOR,
  contracts,
  LOGO_MARK_PATH,
  NOTIFICATION_EMAIL_PREFERENCES,
} from '@openrows/shared';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { RouteRegistry } from '../authz/routes.js';
import type { Database } from '../db/index.js';
import { html, type SafeHtml } from '../email/html.js';
import type { AppEnv } from '../lib/context.js';
import {
  emailPreference,
  listNotifications,
  markOneRead,
  markRead,
  notificationPreferences,
  setEmailPreference,
  unreadCount,
  updateNotificationPreferences,
} from './service.js';
import { verifyUnsubscribeToken } from './unsubscribe.js';

function page(c: Context<AppEnv>, status: 200 | 400, title: string, body: SafeHtml) {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return c.html(
    html`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><title>${title} · ${BRAND}</title></head>
  <body style="font: 14px/1.5 Inter, system-ui, sans-serif; background: #FAF7F5; color: #1C1719; max-width: 480px; margin: 48px auto; padding: 0 24px;">
    <p style="margin: 0 0 24px; font-size: 17px; font-weight: 700; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px;"><svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true"><path fill="${BRAND_COLOR}" d="${LOGO_MARK_PATH}"/></svg>${BRAND}</p>
    <h1 style="font-size: 18px;">${title}</h1>
    ${body}
  </body>
</html>`.value,
    status
  );
}

const button =
  'font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #D7CFC9; background: #FFFFFF; color: #1C1719; cursor: pointer;';

/**
 * Notifications. The inbox, the unread count, marking read and the email preference are the
 * signed-in user's own data (`session`; RLS shows only their notifications). The unsubscribe link
 * of an email is public but needs the signed token: `GET` shows a page (link scanners never
 * change anything), `POST` lowers the preference, also as RFC 8058 one-click
 * (`List-Unsubscribe=One-Click`, sent by mail providers without an `Origin`).
 */
export function notificationRoutes(routes: RouteRegistry, deps: { db: Database; secret: string }) {
  const { db, secret } = deps;
  const n = contracts.notifications;

  routes.endpoint(n.list, 'session', (c, { query }) =>
    listNotifications(db, c.var.principal.user.id, query)
  );
  routes.endpoint(n.unread, 'session', async (c) => ({
    unread: await unreadCount(db, c.var.principal.user.id),
  }));
  routes.endpoint(n.markRead, 'session', async (c, { params }) => ({
    unread: await markOneRead(db, c.var.principal.user.id, params.notificationId),
  }));
  routes.endpoint(n.markAllRead, 'session', async (c) => ({
    unread: await markRead(db, c.var.principal.user.id),
  }));
  routes.endpoint(n.preferences, 'session', (c) =>
    notificationPreferences(db, c.var.principal.user.id)
  );
  routes.endpoint(n.updatePreferences, 'session', (c, { body }) =>
    updateNotificationPreferences(db, c.var.principal.user.id, body)
  );

  const invalid = (c: Context<AppEnv>) =>
    page(
      c,
      400,
      'This link is not valid',
      html`<p>Open <a href="/settings">your settings</a> to choose which emails you get.</p>`
    );

  routes.public('GET', '/email/unsubscribe', async (c) => {
    const token = c.req.query('token') ?? '';
    const userId = verifyUnsubscribeToken(secret, token);
    if (!userId) return invalid(c);
    const action = `/email/unsubscribe?token=${encodeURIComponent(token)}`;
    return page(
      c,
      200,
      'Notification emails',
      html`<p>Stop getting notification emails from ${BRAND}? You still see every notification in the app.</p>
    <form method="post" action="${action}" style="display: flex; gap: 8px; flex-wrap: wrap;">
      <button type="submit" name="email" value="none" style="${button}">Unsubscribe from all</button>
      <button type="submit" name="email" value="mentions" style="${button}">Only when I'm mentioned</button>
      <button type="submit" name="email" value="daily" style="${button}">One daily digest instead</button>
    </form>
    <p style="color: #6E6468;">Or open <a href="/settings" style="color: #C91143;">your settings</a>.</p>`
    );
  });

  const small = bodyLimit({ maxSize: 4096, onError: (c) => c.text('Payload Too Large', 413) });
  routes.public('POST', '/email/unsubscribe', small, async (c) => {
    const userId = verifyUnsubscribeToken(secret, c.req.query('token') ?? '');
    if (!userId) return invalid(c);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const asked = form['email'];
    if (asked === 'daily') {
      // Fewer emails, not fewer notifications: the same ones, once a day.
      await updateNotificationPreferences(db, userId, { frequency: 'daily' });
      c.get('logger').info({ userId }, 'notification emails moved to a daily digest');
      return page(
        c,
        200,
        'One daily digest from now on',
        html`<p>${BRAND} will email your notifications once a day. Change this any time in <a href="/settings">your settings</a>.</p>`
      );
    }
    // One-click (List-Unsubscribe=One-Click) and anything unexpected: no emails at all.
    const level =
      asked === 'mentions' && NOTIFICATION_EMAIL_PREFERENCES.includes(asked) ? 'mentions' : 'none';
    const current = await emailPreference(db, userId);
    // The link only ever lowers the preference.
    if (!(current === 'none' || (current === 'mentions' && level === 'mentions'))) {
      await setEmailPreference(db, userId, level);
    }
    c.get('logger').info({ userId, level }, 'notification emails unsubscribed');
    return page(
      c,
      200,
      level === 'none' ? 'You are unsubscribed' : 'Only mentions from now on',
      html`<p>${
        level === 'none'
          ? `${BRAND} will not email you notifications any more.`
          : `${BRAND} will only email you when someone mentions you.`
      } Change this any time in <a href="/settings">your settings</a>.</p>`
    );
  });
}
