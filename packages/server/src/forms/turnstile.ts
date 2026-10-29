/**
 * Cloudflare Turnstile verification for public forms: the form's widget gives the
 * submitter a one-time token, which the server checks with Cloudflare's siteverify endpoint
 * before it accepts the submission. The secret never leaves this module and is never logged.
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** How long the server waits for Cloudflare before refusing the submission. */
const VERIFY_TIMEOUT_MS = 5_000;

/** Checks a submitter's CAPTCHA token; resolves false for anything but a clear success. */
export type CaptchaVerifier = (input: {
  token: string;
  remoteIp: string | undefined;
  /** Sent as Cloudflare's `idempotency_key`, so a retried check of one token isn't "reused". */
  idempotencyKey: string;
}) => Promise<boolean>;

/**
 * The Turnstile verifier for `secretKey`. A network error, a timeout, a non-2xx answer or an
 * answer that isn't `{ success: true }` all fail closed.
 */
export function turnstileVerifier(
  secretKey: string,
  fetchImpl: typeof fetch = fetch
): CaptchaVerifier {
  return async ({ token, remoteIp, idempotencyKey }) => {
    const body = new URLSearchParams({
      secret: secretKey,
      response: token,
      idempotency_key: idempotencyKey,
    });
    if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp);
    try {
      const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const answer = (await res.json()) as { success?: unknown };
      return answer.success === true;
    } catch {
      return false;
    }
  };
}
