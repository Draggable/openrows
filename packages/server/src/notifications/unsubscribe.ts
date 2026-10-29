import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * One-click unsubscribe tokens for notification emails: `<user id>.<HMAC-SHA256>` with a
 * key derived from ENCRYPTION_KEY for this purpose only. They don't expire (an unsubscribe link
 * in an old email must keep working) and only ever lower the user's email preference.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, 'openrows', 'openrows:notification-unsubscribe', 32)
  );
}

function sign(secret: string, userId: string): Buffer {
  return createHmac('sha256', key(secret)).update(`unsubscribe:v1:${userId}`).digest();
}

export function unsubscribeToken(secret: string, userId: string): string {
  return `${userId}.${sign(secret, userId).toString('base64url')}`;
}

/** The user id a token was made for, or undefined when it was tampered with or is malformed. */
export function verifyUnsubscribeToken(secret: string, token: string): string | undefined {
  if (token.length > 200) return undefined;
  const [userId, mac, ...rest] = token.split('.');
  if (!userId || !mac || rest.length > 0 || !UUID.test(userId)) return undefined;
  const given = Buffer.from(mac, 'base64url');
  const expected = sign(secret, userId);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return userId;
}
