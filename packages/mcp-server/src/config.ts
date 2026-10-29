import { DEFAULT_BASE_URL } from '@openrows/sdk';

/**
 * The stdio server's configuration, from the environment an MCP client passes in its `env`
 * settings:
 *
 * - `OPENROWS_API_KEY` (required): a personal access token, `or_pat_<id>_<secret>`.
 * - `OPENROWS_URL` (optional, default `https://app.openrows.io`): your OpenRows origin.
 */
export interface OpenRowsMcpConfig {
  apiKey: string;
  /** The app's origin, no trailing slash. */
  url: string;
}

/** The server's personal access token format (`or_pat_` + 12 base32 + `_` + 43 base64url). */
export const API_KEY_PATTERN = /^or_pat_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;

/** Anything that looks like a token, so it can be scrubbed from text. */
const KEY_LIKE = /or_pat_[A-Za-z0-9_-]{4,}/g;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** `text` with anything that looks like a personal access token (and `apiKey`) replaced. */
export function redact(text: string, apiKey?: string): string {
  const scrubbed = apiKey ? text.split(apiKey).join('or_pat_[redacted]') : text;
  return scrubbed.replace(KEY_LIKE, 'or_pat_[redacted]');
}

/** Whether the token would cross the network unencrypted: http to a host other than this one. */
export function isInsecureUrl(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'http:') return false;
  return (
    !['localhost', '127.0.0.1', '[::1]'].includes(hostname) && !hostname.endsWith('.localhost')
  );
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): OpenRowsMcpConfig {
  const apiKey = env['OPENROWS_API_KEY']?.trim();
  if (!apiKey) {
    throw new ConfigError(
      'OPENROWS_API_KEY is not set. Create a personal access token in OpenRows (Settings → ' +
        'Developer: personal access tokens) and pass it to this server in its env settings.'
    );
  }
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new ConfigError(
      'OPENROWS_API_KEY is not an OpenRows personal access token: tokens start with or_pat_. ' +
        'Copy the whole token, shown once when it was created.'
    );
  }
  const raw = env['OPENROWS_URL']?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`OPENROWS_URL is not a URL: ${JSON.stringify(redact(raw))}.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('OPENROWS_URL must be an http(s) URL, like https://app.openrows.io.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError('OPENROWS_URL must be a plain origin, like https://app.openrows.io.');
  }
  // `<origin>/api` and `<origin>/api/v1` are accepted as the SDK accepts them.
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api(\/v1)?$/, '');
  return { apiKey, url: `${url.origin}${path}` };
}
