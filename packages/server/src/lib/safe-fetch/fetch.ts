import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';
import { BRAND } from '@openrows/shared';
import { blockedReason, canonicalIp, isMetadataAddress, normalizeHostname } from './address.js';
import type { OutboundPolicy } from './policy.js';

/**
 * The SSRF-safe HTTP client (ADR-004 §5): the only way the server requests a URL a user
 * chose (webhooks, automation HTTP and Slack actions, the Airtable attachment copy). A test
 * (`boundary.test.ts`) fails when other server code makes outbound requests.
 *
 * Per hop (the request and each of at most 3 redirects): the URL must be https (http only with
 * `OUTBOUND_HTTP_ALLOW_HTTP`), on port 80 or 443 (or `OUTBOUND_HTTP_PORTS`), without
 * credentials; the hostname is resolved once and every address must be public (address.ts) or
 * allowlisted, and not denylisted. The connection then goes to that pinned address through the
 * socket's `lookup`, keeping the hostname for the Host header, SNI and the certificate check,
 * so a second DNS answer (rebinding) can't switch it to another address. Proxy environment
 * variables are never read (a fresh agent per request), the User-Agent is fixed, responses
 * aren't decompressed (`Accept-Encoding: identity`) and are read up to `maxBytes`, and the
 * whole exchange, redirects included, has one deadline.
 */

export const USER_AGENT = `${BRAND}/1.0 (+https://openrows.io)`;
export const MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export type SafeFetchErrorCode =
  | 'INVALID_URL'
  | 'PROTOCOL_NOT_ALLOWED'
  | 'PORT_NOT_ALLOWED'
  | 'CREDENTIALS_IN_URL'
  | 'ADDRESS_NOT_ALLOWED'
  | 'DNS_FAILED'
  | 'TOO_MANY_REDIRECTS'
  | 'TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'CONNECTION_FAILED'
  | 'TLS_FAILED'
  | 'INVALID_REQUEST'
  | 'ABORTED';

/** A refused or failed request. The message is safe to show the user (no resolved addresses). */
export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'SafeFetchError';
  }
}

export type SafeFetchMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface SafeFetchInit {
  method?: SafeFetchMethod;
  /** Hop-by-hop, framing, Host, User-Agent and Accept-Encoding headers are replaced. */
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** 0 to 3 (the default); a redirect beyond it fails with TOO_MANY_REDIRECTS. */
  maxRedirects?: number;
  /** The response body's cap in bytes (default 1 MiB): RESPONSE_TOO_LARGE beyond it. */
  maxBytes?: number;
  /** The deadline for everything, redirects and the body included (default 15 s). */
  timeoutMs?: number;
  /** Per connection, until the socket (and TLS) is up (default 5 s). */
  connectTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface SafeResponse {
  status: number;
  statusText: string;
  headers: Headers;
  /** The final URL, after redirects. */
  url: string;
  redirected: boolean;
  body: Buffer;
  text(): string;
}

export type SafeFetch = (url: string | URL, init?: SafeFetchInit) => Promise<SafeResponse>;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface SafeFetchDeps {
  /** DNS resolution (default: `dns.lookup` with every address). Tests inject a resolver. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Extra trusted CA certificates (tests' self-signed servers). */
  ca?: string | Buffer;
}

const STRIPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
  'user-agent',
  'accept-encoding',
]);
/** Dropped when a redirect leaves the origin, like fetch() does with Authorization. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function systemResolve(hostname: string): Promise<ResolvedAddress[]> {
  const answers: LookupAddress[] = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

interface Target {
  hostname: string;
  port: number;
  pinned: ResolvedAddress;
}

/**
 * Resolves a hostname (or IP literal) and pins the address to connect to: every answer must be
 * public or allowlisted, and none denylisted or a cloud metadata address.
 */
async function resolveHost(
  policy: OutboundPolicy,
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
  rawHostname: string,
  signal: AbortSignal
): Promise<{ hostname: string; pinned: ResolvedAddress }> {
  const literal = canonicalIp(rawHostname);
  const hostname = literal ?? normalizeHostname(rawHostname);
  const refused = new SafeFetchError(
    'ADDRESS_NOT_ALLOWED',
    `${hostname} is a private or reserved address`
  );
  if (policy.deny.matchesHost(hostname)) throw refused;
  const hostAllowed = literal === null && policy.allow.matchesHost(hostname);
  if (
    literal === null &&
    !hostAllowed &&
    (hostname === 'localhost' || hostname.endsWith('.localhost'))
  ) {
    throw refused;
  }

  let addresses: ResolvedAddress[];
  if (literal !== null) {
    addresses = [{ address: literal, family: literal.includes(':') ? 6 : 4 }];
  } else {
    try {
      addresses = await abortable(resolve(hostname), signal);
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      throw new SafeFetchError('DNS_FAILED', `${hostname} could not be resolved`, { cause: err });
    }
    if (addresses.length === 0) {
      throw new SafeFetchError('DNS_FAILED', `${hostname} could not be resolved`);
    }
  }
  // Every address must pass, not just the one we pick: no mixing a public and a private answer.
  for (const { address } of addresses) {
    if (isMetadataAddress(address) || policy.deny.matchesIp(address)) throw refused;
    if (blockedReason(address) !== null && !hostAllowed && !policy.allow.matchesIp(address)) {
      throw refused;
    }
  }
  const [first] = addresses;
  if (!first) throw refused;
  const pinned = { address: canonicalIp(first.address) ?? first.address, family: first.family };
  return { hostname, pinned };
}

/** Validates one hop and pins the address it connects to. */
async function checkTarget(
  policy: OutboundPolicy,
  resolve: (hostname: string) => Promise<ResolvedAddress[]>,
  url: URL,
  signal: AbortSignal
): Promise<Target> {
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.allowHttp)) {
    throw new SafeFetchError(
      'PROTOCOL_NOT_ALLOWED',
      policy.allowHttp ? 'Only http and https URLs are allowed' : 'Only https URLs are allowed'
    );
  }
  if (url.username || url.password) {
    throw new SafeFetchError('CREDENTIALS_IN_URL', 'URLs with credentials are not allowed');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!policy.ports.has(port)) {
    throw new SafeFetchError('PORT_NOT_ALLOWED', `Port ${port} is not allowed`);
  }
  const { hostname, pinned } = await resolveHost(policy, resolve, url.hostname, signal);
  return { hostname, port, pinned };
}

/**
 * Checks a URL against the same rules a request to it would meet (protocol, port, credentials,
 * DNS answers), without connecting: for URLs saved now and requested later (webhooks).
 * Throws SafeFetchError; redirects are only known when the request is made, and checked then.
 */
export function createUrlCheck(
  policy: OutboundPolicy,
  deps: SafeFetchDeps = {}
): (url: string | URL, opts?: { timeoutMs?: number }) => Promise<void> {
  const resolve = deps.resolve ?? systemResolve;
  return async (input, opts = {}) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new SafeFetchError('INVALID_URL', 'The URL is not valid');
    }
    const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    try {
      await checkTarget(policy, resolve, url, signal);
    } catch (err) {
      if (signal.aborted && !(err instanceof SafeFetchError)) {
        throw new SafeFetchError('TIMEOUT', 'The URL could not be checked in time');
      }
      throw err;
    }
  };
}

/**
 * Checks a host a non-HTTP client connects to (a Postgres sync source) by the same address
 * rules, and returns the address to connect to (pinned, so a second DNS answer can't move it).
 * Protocols and ports are the caller's. Throws SafeFetchError.
 */
export function createHostCheck(
  policy: OutboundPolicy,
  deps: Pick<SafeFetchDeps, 'resolve'> = {}
): (
  hostname: string,
  opts?: { timeoutMs?: number }
) => Promise<{
  hostname: string;
  address: ResolvedAddress;
}> {
  const resolve = deps.resolve ?? systemResolve;
  return async (input, opts = {}) => {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    // A bracketed IPv6 literal, as URLs write it.
    const raw = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
    try {
      const { hostname, pinned } = await resolveHost(policy, resolve, raw, signal);
      return { hostname, address: pinned };
    } catch (err) {
      if (signal.aborted && !(err instanceof SafeFetchError)) {
        throw new SafeFetchError('TIMEOUT', 'The host could not be checked in time');
      }
      throw err;
    }
  };
}

export function createSafeFetch(policy: OutboundPolicy, deps: SafeFetchDeps = {}): SafeFetch {
  const resolve = deps.resolve ?? systemResolve;
  const check = (url: URL, signal: AbortSignal) => checkTarget(policy, resolve, url, signal);

  return async function safeFetch(input, init = {}) {
    const maxRedirects = Math.max(0, Math.min(MAX_REDIRECTS, init.maxRedirects ?? MAX_REDIRECTS));
    const maxBytes = init.maxBytes ?? DEFAULT_MAX_BYTES;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new SafeFetchError('TIMEOUT', 'The request timed out')),
      init.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const onAbort = () =>
      controller.abort(new SafeFetchError('ABORTED', 'The request was aborted'));
    if (init.signal?.aborted) onAbort();
    init.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        throw new SafeFetchError('INVALID_URL', 'The URL is not valid');
      }
      let method: SafeFetchMethod = init.method ?? 'GET';
      let body = init.body;
      const headers = new Map<string, string>();
      for (const [name, value] of Object.entries(init.headers ?? {})) {
        const key = name.toLowerCase();
        if (!STRIPPED_HEADERS.has(key)) headers.set(key, value);
      }

      for (let hop = 0; ; hop++) {
        const target = await check(url, controller.signal);
        const res = await send(url, target, method, headers, body, {
          signal: controller.signal,
          connectTimeoutMs: init.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          ca: deps.ca,
        });
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (REDIRECTS.has(status) && location !== undefined) {
          res.destroy();
          if (hop >= maxRedirects) {
            throw new SafeFetchError('TOO_MANY_REDIRECTS', 'Too many redirects');
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw new SafeFetchError('INVALID_URL', 'The redirect location is not valid');
          }
          if (status === 303 ? method !== 'HEAD' : status <= 302 && method === 'POST') {
            method = 'GET';
            body = undefined;
            headers.delete('content-type');
          }
          if (next.origin !== url.origin) for (const h of CREDENTIAL_HEADERS) headers.delete(h);
          url = next;
          continue;
        }
        // HEAD has no body, whatever Content-Length says.
        if (method === 'HEAD') res.destroy();
        const data =
          method === 'HEAD' ? Buffer.alloc(0) : await readBody(res, maxBytes, controller.signal);
        const responseHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            responseHeaders.append(res.rawHeaders[i] ?? '', res.rawHeaders[i + 1] ?? '');
          } catch {
            // A header fetch's Headers refuses is left out.
          }
        }
        return {
          status,
          statusText: res.statusMessage ?? '',
          headers: responseHeaders,
          url: url.toString(),
          redirected: hop > 0,
          body: data,
          text: () => data.toString('utf8'),
        };
      }
    } catch (err) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw err;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const TLS_ERROR = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL)/;

function connectionError(err: unknown): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TLS_ERROR.test(code)) {
    return new SafeFetchError('TLS_FAILED', 'The TLS handshake failed', { cause: err });
  }
  if (code === 'ERR_INVALID_CHAR' || code === 'ERR_INVALID_HTTP_TOKEN') {
    return new SafeFetchError('INVALID_REQUEST', 'A request header is not valid', { cause: err });
  }
  return new SafeFetchError('CONNECTION_FAILED', 'The connection failed', { cause: err });
}

function send(
  url: URL,
  target: Target,
  method: SafeFetchMethod,
  headers: Map<string, string>,
  body: string | Uint8Array | undefined,
  opts: { signal: AbortSignal; connectTimeoutMs: number; ca: string | Buffer | undefined }
): Promise<http.IncomingMessage> {
  const secure = url.protocol === 'https:';
  const { pinned } = target;
  // Every connection resolves to the address `check` validated, whatever DNS says now. Node
  // asks for one address or, with `all` (family autoselection), a list.
  const lookup = (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void
  ) => {
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
  const outgoing: Record<string, string> = Object.fromEntries(headers);
  outgoing['user-agent'] = USER_AGENT;
  outgoing['accept-encoding'] = 'identity';
  if (body !== undefined) outgoing['content-length'] = String(Buffer.byteLength(body));

  return new Promise((resolve, reject) => {
    let req: http.ClientRequest;
    let connectTimer: NodeJS.Timeout | undefined;
    const options: https.RequestOptions = {
      hostname: target.hostname,
      port: target.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: outgoing,
      lookup: lookup as unknown as https.RequestOptions['lookup'],
      family: pinned.family,
      // A fresh agent: no pooled sockets, and never a proxy from the environment.
      agent: secure
        ? new https.Agent({ keepAlive: false, ...(opts.ca ? { ca: opts.ca } : {}) })
        : new http.Agent({ keepAlive: false }),
      signal: opts.signal,
      maxHeaderSize: 16 * 1024,
      ...(secure && canonicalIp(target.hostname) === null ? { servername: target.hostname } : {}),
    };
    try {
      req = (secure ? https : http).request(options);
    } catch (err) {
      reject(connectionError(err));
      return;
    }
    const fail = (err: unknown) => {
      clearTimeout(connectTimer);
      reject(opts.signal.aborted ? opts.signal.reason : connectionError(err));
    };
    req.on('error', fail);
    req.on('socket', (socket: Socket) => {
      connectTimer = setTimeout(
        () => req.destroy(new SafeFetchError('TIMEOUT', 'The connection timed out')),
        opts.connectTimeoutMs
      );
      socket.once(secure ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    req.on('response', (res) => {
      clearTimeout(connectTimer);
      // The deadline also covers the body; errors there surface in readBody.
      res.on('error', () => {});
      resolve(res);
    });
    req.end(body);
  });
}

function readBody(
  res: http.IncomingMessage,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = () =>
      new SafeFetchError('RESPONSE_TOO_LARGE', `The response is larger than ${maxBytes} bytes`);
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onAbort = () => {
      res.destroy();
      reject(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    const done = () => signal.removeEventListener('abort', onAbort);
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        done();
        res.destroy();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      done();
      resolve(Buffer.concat(chunks));
    });
    res.on('error', (err) => {
      done();
      reject(signal.aborted ? signal.reason : connectionError(err));
    });
    res.on('close', () => {
      if (!res.complete) {
        done();
        reject(signal.aborted ? signal.reason : connectionError(new Error('response cut short')));
      }
    });
  });
}
