import { describe, expect, it, vi } from 'vitest';
import { TURNSTILE_VERIFY_URL, turnstileVerifier } from './turnstile.js';

// Cloudflare's documented test secret keys: they never reach Cloudflare here.
const PASS_SECRET = '1x0000000000000000000000000000000AA';

function answering(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status })
  );
}

describe('turnstileVerifier', () => {
  const input = { token: 'XXXX.DUMMY.TOKEN.XXXX', remoteIp: '203.0.113.9', idempotencyKey: 'k1' };

  it('posts the secret, token, client IP and idempotency key to siteverify', async () => {
    const fetchImpl = answering(200, { success: true });
    expect(await turnstileVerifier(PASS_SECRET, fetchImpl)(input)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(TURNSTILE_VERIFY_URL);
    expect(init?.method).toBe('POST');
    const body = init?.body as URLSearchParams;
    expect(body.get('secret')).toBe(PASS_SECRET);
    expect(body.get('response')).toBe(input.token);
    expect(body.get('remoteip')).toBe('203.0.113.9');
    expect(body.get('idempotency_key')).toBe('k1');
  });

  it('leaves out an unknown client IP', async () => {
    const fetchImpl = answering(200, { success: true });
    await turnstileVerifier(PASS_SECRET, fetchImpl)({ ...input, remoteIp: 'unknown' });
    const body = fetchImpl.mock.calls[0]?.[1]?.body as URLSearchParams | undefined;
    expect(body?.has('remoteip')).toBe(false);
  });

  it('fails closed on a refusal, an odd answer, an HTTP error or a network error', async () => {
    const cases = [
      answering(200, { success: false, 'error-codes': ['invalid-input-response'] }),
      answering(200, { success: 'true' }),
      answering(200, {}),
      answering(500, { success: true }),
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    ];
    for (const fetchImpl of cases) {
      expect(await turnstileVerifier(PASS_SECRET, fetchImpl as typeof fetch)(input)).toBe(false);
    }
  });
});
