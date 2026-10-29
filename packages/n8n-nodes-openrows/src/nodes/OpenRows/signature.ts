import { createHmac, timingSafeEqual } from 'node:crypto';

/** How old a signature's timestamp the trigger accepts, either way (docs/api/webhooks.md). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** Longer `X-OpenRows-Signature` headers are refused unread. */
const MAX_HEADER_LENGTH = 1024;

/**
 * Checks `X-OpenRows-Signature` (`t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`)
 * against the raw body as received: refuses a timestamp more than the tolerance from `now`
 * (replays) and compares the HMAC in constant time.
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  rawBody: Buffer | string,
  opts: { now?: number; toleranceSeconds?: number } = {}
): boolean {
  if (!secret || !header || header.length > MAX_HEADER_LENGTH) return false;
  const parts = new Map<string, string[]>();
  for (const item of header.split(',')) {
    const [key, value] = item.split('=', 2);
    if (!key || value === undefined) continue;
    parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
  }
  const t = Number(parts.get('t')?.[0]);
  if (!Number.isInteger(t)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), body]))
    .digest();
  return (parts.get('v1') ?? []).some((candidate) => {
    if (!/^[0-9a-f]+$/i.test(candidate)) return false;
    const given = Buffer.from(candidate, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
