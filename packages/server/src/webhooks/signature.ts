import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_SECRET_PREFIX, WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } from '@openrows/shared';

/** A new signing secret: `whsec_` and 32 random bytes, base64url. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** HMAC-SHA256 of `<t>.<body>` with the secret, hex: the `v1` part of the signature header. */
export function webhookSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * `X-OpenRows-Signature`: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`, with
 * one `v1` per secret (the current one first, then the previous one during its grace
 * period). A receiver accepts the request when any `v1` matches its secret.
 */
export function signatureHeader(
  secrets: string | readonly string[],
  timestamp: number,
  body: string
): string {
  const all = typeof secrets === 'string' ? [secrets] : secrets;
  return [`t=${timestamp}`, ...all.map((s) => `v1=${webhookSignature(s, timestamp, body)}`)].join(
    ','
  );
}

/**
 * What a receiver does (docs/api/webhooks.md has the same code): parse the header, refuse a
 * timestamp outside the tolerance (replays), recompute the HMAC over the raw body and compare in
 * constant time. Exported for the tests and anyone embedding OpenRows' server code.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  opts: { now?: number; toleranceSeconds?: number } = {}
): boolean {
  const parts = new Map<string, string[]>();
  for (const item of header.split(',')) {
    const [key, value] = item.split('=', 2);
    if (!key || value === undefined) continue;
    parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
  }
  const t = Number(parts.get('t')?.[0]);
  if (!Number.isInteger(t)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS)) {
    return false;
  }
  const expected = Buffer.from(webhookSignature(secret, t, body), 'hex');
  return (parts.get('v1') ?? []).some((candidate) => {
    const given = Buffer.from(candidate, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
