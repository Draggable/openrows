import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFUSED_URLS } from './__fixtures__/refused-urls.js';
import {
  createSafeFetch,
  createUrlCheck,
  type OutboundConfig,
  outboundPolicy,
  type ResolvedAddress,
  type SafeFetch,
  SafeFetchError,
  USER_AGENT,
} from './index.js';

// A self-signed certificate for hooks.example.test, valid until 2126; test-only key material.
const FIXTURES = new URL('./__fixtures__/', import.meta.url);
const CERT = readFileSync(new URL('test-server.crt', FIXTURES));
const KEY = readFileSync(new URL('test-server.key', FIXTURES));

const HOST = 'hooks.example.test';
const OTHER = 'other.example.test';

let httpServer: Server;
let httpsServer: HttpsServer;
let proxy: Server;
let httpPort: number;
let httpsPort: number;
let proxyHits = 0;
const openResponses = new Set<ServerResponse>();

function echo(req: IncomingMessage, res: ServerResponse, extra: Record<string, unknown> = {}) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c: string) => {
    body += c;
  });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body, ...extra })
    );
  });
}

function routes(req: IncomingMessage, res: ServerResponse, origin: string) {
  const url = new URL(req.url ?? '/', 'http://x');
  const hops = /^\/redirect\/(\d+)$/.exec(url.pathname);
  if (hops) {
    const n = Number(hops[1]);
    res.writeHead(302, { location: n > 1 ? `/redirect/${n - 1}` : '/echo' }).end();
    return;
  }
  switch (url.pathname) {
    case '/to': {
      res.writeHead(Number(url.searchParams.get('status') ?? 302), {
        location: url.searchParams.get('location') ?? '/echo',
      });
      res.end();
      return;
    }
    case '/to-metadata':
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      return;
    case '/to-other':
      res.writeHead(302, { location: `${origin.replace(HOST, OTHER)}/echo` }).end();
      return;
    case '/big': {
      // 2 MiB, chunked: no Content-Length to stop it early.
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 1);
      for (let i = 0; i < 32; i++) res.write(chunk);
      res.end();
      return;
    }
    case '/big-declared':
      res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.write('x');
      openResponses.add(res);
      return;
    case '/slow': {
      // Slowloris: headers at once, then a byte every 50 ms, forever.
      res.writeHead(200, { 'content-type': 'text/plain' });
      openResponses.add(res);
      const timer = setInterval(() => res.write('.'), 50);
      res.on('close', () => clearInterval(timer));
      return;
    }
    case '/hang':
      openResponses.add(res);
      return;
    default:
      echo(req, res);
  }
}

function listen(server: Server | HttpsServer): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  );
}

beforeAll(async () => {
  httpServer = createServer((req, res) => routes(req, res, `http://${HOST}:${httpPort}`));
  httpsServer = createHttpsServer({ cert: CERT, key: KEY }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://x');
    if (url.pathname === '/tls') {
      echo(req, res, { servername: (req.socket as TLSSocket).servername });
      return;
    }
    routes(req, res, `https://${HOST}:${httpsPort}`);
  });
  proxy = createServer((_req, res) => {
    proxyHits++;
    res.writeHead(502).end();
  });
  [httpPort, httpsPort] = await Promise.all([listen(httpServer), listen(httpsServer)]);
  await listen(proxy);
});

afterAll(async () => {
  for (const res of openResponses) res.destroy();
  for (const server of [httpServer, httpsServer, proxy]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A resolver for the test names; anything else fails like NXDOMAIN. */
function resolver(table: Record<string, string[]> = {}) {
  const calls: string[] = [];
  const resolve = async (hostname: string): Promise<ResolvedAddress[]> => {
    calls.push(hostname);
    const answers = table[hostname] ?? (hostname.endsWith('.example.test') ? ['127.0.0.1'] : []);
    if (answers.length === 0) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolve, calls };
}

/** The test server is local, so it's reachable only through the allowlist, like an n8n. */
function client(config: Partial<OutboundConfig> = {}, resolve = resolver().resolve): SafeFetch {
  return createSafeFetch(
    outboundPolicy({
      allowHttp: true,
      extraPorts: [httpPort, httpsPort],
      allow: ['127.0.0.1'],
      deny: [],
      ...config,
    }),
    { resolve, ca: CERT }
  );
}

async function failure(promise: Promise<unknown>): Promise<SafeFetchError> {
  const err = await promise.then(
    () => {
      throw new Error('expected the request to fail');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(SafeFetchError);
  return err as SafeFetchError;
}

describe('safeFetch: refused targets', () => {
  // http and every port allowed, nothing allowlisted: only the address rules refuse.
  const open = () => {
    const dns = resolver();
    const fetch = createSafeFetch(
      outboundPolicy({ allowHttp: true, extraPorts: [8080], allow: [], deny: [] }),
      { resolve: dns.resolve }
    );
    return { fetch, dns };
  };

  it.each(REFUSED_URLS)('refuses %s before connecting', async (url) => {
    const { fetch, dns } = open();
    const err = await failure(fetch(url));
    expect(err.code).toBe('ADDRESS_NOT_ALLOWED');
    expect(dns.calls).toEqual([]);
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const { resolve } = resolver({ 'internal.example.com': ['10.1.2.3'] });
    const fetch = createSafeFetch(outboundPolicy({ ...base(), allowHttp: true }), { resolve });
    const err = await failure(fetch('http://internal.example.com/'));
    expect(err.code).toBe('ADDRESS_NOT_ALLOWED');
    // The message names the host, never the internal address it resolved to.
    expect(err.message).not.toContain('10.1.2.3');
  });

  it('refuses a hostname when any of its addresses is private', async () => {
    const { resolve } = resolver({ 'mixed.example.com': ['93.184.215.14', '127.0.0.1'] });
    const fetch = createSafeFetch(outboundPolicy(base()), { resolve });
    expect((await failure(fetch('https://mixed.example.com/'))).code).toBe('ADDRESS_NOT_ALLOWED');
  });

  it('never reaches the metadata service, even when its range is allowlisted', async () => {
    const fetch = createSafeFetch(
      outboundPolicy({ ...base(), allowHttp: true, allow: ['169.254.0.0/16', 'meta.lan'] }),
      { resolve: resolver({ 'meta.lan': ['169.254.169.254'] }).resolve }
    );
    for (const url of ['http://169.254.169.254/', 'http://meta.lan/', 'http://[fd00:ec2::254]/']) {
      expect((await failure(fetch(url))).code).toBe('ADDRESS_NOT_ALLOWED');
    }
  });

  it('is https only by default, on ports 80 and 443, without credentials', async () => {
    const fetch = createSafeFetch(outboundPolicy(base()), {
      resolve: resolver({ 'example.com': ['93.184.215.14'] }).resolve,
    });
    const cases: [string, string][] = [
      ['http://example.com/', 'PROTOCOL_NOT_ALLOWED'],
      ['ftp://example.com/', 'PROTOCOL_NOT_ALLOWED'],
      ['file:///etc/passwd', 'PROTOCOL_NOT_ALLOWED'],
      ['data:text/plain,hi', 'PROTOCOL_NOT_ALLOWED'],
      ['gopher://example.com:70/', 'PROTOCOL_NOT_ALLOWED'],
      ['https://example.com:22/', 'PORT_NOT_ALLOWED'],
      ['https://example.com:6379/', 'PORT_NOT_ALLOWED'],
      ['https://user:pass@example.com/', 'CREDENTIALS_IN_URL'],
      ['not a url', 'INVALID_URL'],
    ];
    for (const [url, code] of cases) expect((await failure(fetch(url))).code, url).toBe(code);
  });

  it('applies the denylist before the allowlist', async () => {
    const fetch = client({ deny: [HOST] });
    expect((await failure(fetch(`http://${HOST}:${httpPort}/echo`))).code).toBe(
      'ADDRESS_NOT_ALLOWED'
    );
    const byIp = client({ deny: ['127.0.0.0/8'] });
    expect((await failure(byIp(`http://${HOST}:${httpPort}/echo`))).code).toBe(
      'ADDRESS_NOT_ALLOWED'
    );
    const public_ = createSafeFetch(outboundPolicy({ ...base(), deny: ['*.example.com'] }), {
      resolve: resolver({ 'hooks.example.com': ['93.184.215.14'] }).resolve,
    });
    expect((await failure(public_('https://hooks.example.com/'))).code).toBe('ADDRESS_NOT_ALLOWED');
  });

  it('reports a name that does not resolve', async () => {
    const fetch = createSafeFetch(outboundPolicy(base()), { resolve: resolver().resolve });
    expect((await failure(fetch('https://nope.invalid/'))).code).toBe('DNS_FAILED');
  });
});

function base(): OutboundConfig {
  return { allowHttp: false, extraPorts: [], allow: [], deny: [] };
}

describe('safeFetch: the happy path (an allowlisted local server)', () => {
  it('sends the request with a fixed User-Agent and no compression', async () => {
    const res = await client()(`http://${HOST}:${httpPort}/echo?x=1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'curl/8',
        'x-openrows-signature': 't=1,v1=abc',
        'accept-encoding': 'gzip',
        host: 'evil.example.com',
      },
      body: '{"hello":"world"}',
    });
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(false);
    expect(res.url).toBe(`http://${HOST}:${httpPort}/echo?x=1`);
    expect(res.headers.get('content-type')).toBe('application/json');
    const seen = JSON.parse(res.text());
    expect(seen).toMatchObject({ method: 'POST', url: '/echo?x=1', body: '{"hello":"world"}' });
    expect(seen.headers).toMatchObject({
      host: `${HOST}:${httpPort}`,
      'user-agent': USER_AGENT,
      'accept-encoding': 'identity',
      'content-type': 'application/json',
      'x-openrows-signature': 't=1,v1=abc',
      'content-length': '17',
    });
  });

  it('connects to the pinned address with the hostname for SNI and the certificate', async () => {
    const res = await client()(`https://${HOST}:${httpsPort}/tls`);
    expect(res.status).toBe(200);
    const seen = JSON.parse(res.text());
    expect(seen.servername).toBe(HOST);
    expect(seen.headers.host).toBe(`${HOST}:${httpsPort}`);
    // The certificate is checked against the URL's name: the bare IP doesn't match it.
    expect((await failure(client()(`https://127.0.0.1:${httpsPort}/tls`))).code).toBe('TLS_FAILED');
  });

  it('allows a private target by hostname', async () => {
    const fetch = client({ allow: [HOST] });
    expect((await fetch(`http://${HOST}:${httpPort}/echo`)).status).toBe(200);
    const other = await failure(fetch(`http://${OTHER}:${httpPort}/echo`));
    expect(other.code).toBe('ADDRESS_NOT_ALLOWED');
  });

  it('never goes through a proxy from the environment', async () => {
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY'];
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) process.env[k] = proxyUrl;
    try {
      expect((await client()(`http://${HOST}:${httpPort}/echo`)).status).toBe(200);
      expect((await client()(`https://${HOST}:${httpsPort}/echo`)).status).toBe(200);
    } finally {
      keys.forEach((k, i) => {
        const value = saved[i];
        if (value === undefined) delete process.env[k];
        else process.env[k] = value;
      });
    }
    expect(proxyHits).toBe(0);
  });

  it('refuses header injection', async () => {
    const err = await failure(
      client()(`http://${HOST}:${httpPort}/echo`, { headers: { 'x-a': 'b\r\nx-injected: 1' } })
    );
    expect(err.code).toBe('INVALID_REQUEST');
  });
});

describe('safeFetch: DNS rebinding', () => {
  it('resolves once and connects to that address, whatever DNS answers next', async () => {
    let answers = 0;
    const calls: string[] = [];
    // Public (here: the allowlisted test server) first, then private (the metadata service).
    const rebinding = async (hostname: string): Promise<ResolvedAddress[]> => {
      calls.push(hostname);
      answers++;
      return [{ address: answers === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }];
    };
    const fetch = client({}, rebinding);
    const res = await fetch(`http://${HOST}:${httpPort}/echo`);
    expect(res.status).toBe(200);
    expect(calls).toEqual([HOST]);
  });

  it('re-resolves and re-checks every redirect hop', async () => {
    let answers = 0;
    const rebinding = async (): Promise<ResolvedAddress[]> => {
      answers++;
      return [{ address: answers === 1 ? '127.0.0.1' : '10.0.0.7', family: 4 }];
    };
    const err = await failure(client({}, rebinding)(`http://${HOST}:${httpPort}/redirect/1`));
    expect(err.code).toBe('ADDRESS_NOT_ALLOWED');
    expect(answers).toBe(2);
  });
});

describe('safeFetch: redirects', () => {
  it('follows up to 3 redirects, each re-validated', async () => {
    const res = await client()(`http://${HOST}:${httpPort}/redirect/3`);
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    expect(res.url).toBe(`http://${HOST}:${httpPort}/echo`);
    const err = await failure(client()(`http://${HOST}:${httpPort}/redirect/4`));
    expect(err.code).toBe('TOO_MANY_REDIRECTS');
    const none = await failure(
      client()(`http://${HOST}:${httpPort}/redirect/1`, { maxRedirects: 0 })
    );
    expect(none.code).toBe('TOO_MANY_REDIRECTS');
  });

  it('refuses a redirect to a private address', async () => {
    const err = await failure(client()(`http://${HOST}:${httpPort}/to-metadata`));
    expect(err.code).toBe('ADDRESS_NOT_ALLOWED');
    const loopback = encodeURIComponent('http://[::1]/admin');
    const err2 = await failure(client()(`http://${HOST}:${httpPort}/to?location=${loopback}`));
    expect(err2.code).toBe('ADDRESS_NOT_ALLOWED');
  });

  it('refuses a redirect from https to http when only https is allowed', async () => {
    const location = encodeURIComponent(`http://${HOST}:${httpPort}/echo`);
    const err = await failure(
      client({ allowHttp: false })(`https://${HOST}:${httpsPort}/to?location=${location}`)
    );
    expect(err.code).toBe('PROTOCOL_NOT_ALLOWED');
  });

  it('turns a POST into a GET on 302 and keeps it on 307', async () => {
    const post = { method: 'POST' as const, body: 'payload', headers: { 'content-type': 'x/y' } };
    const found = JSON.parse((await client()(`http://${HOST}:${httpPort}/to`, post)).text());
    expect(found).toMatchObject({ method: 'GET', body: '' });
    expect(found.headers['content-type']).toBeUndefined();
    const kept = JSON.parse(
      (await client()(`http://${HOST}:${httpPort}/to?status=307`, post)).text()
    );
    expect(kept).toMatchObject({ method: 'POST', body: 'payload' });
  });

  it('drops credentials when a redirect leaves the origin', async () => {
    const headers = { authorization: 'Bearer s3cret', 'x-keep': '1' };
    const same = JSON.parse(
      (await client()(`http://${HOST}:${httpPort}/redirect/1`, { headers })).text()
    );
    expect(same.headers).toMatchObject({ authorization: 'Bearer s3cret', 'x-keep': '1' });
    const other = JSON.parse(
      (await client()(`http://${HOST}:${httpPort}/to-other`, { headers })).text()
    );
    expect(other.headers.host).toBe(`${OTHER}:${httpPort}`);
    expect(other.headers.authorization).toBeUndefined();
    expect(other.headers['x-keep']).toBe('1');
  });
});

describe('safeFetch: size and time limits', () => {
  it('stops reading a body over the cap', async () => {
    const fetch = client();
    const streamed = await failure(fetch(`http://${HOST}:${httpPort}/big`));
    expect(streamed.code).toBe('RESPONSE_TOO_LARGE');
    const declared = await failure(fetch(`http://${HOST}:${httpPort}/big-declared`));
    expect(declared.code).toBe('RESPONSE_TOO_LARGE');
    // HEAD has no body, whatever Content-Length announces.
    const head = await fetch(`http://${HOST}:${httpPort}/big-declared`, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(50 * 1024 * 1024));
    expect(head.body.length).toBe(0);
    const res = await fetch(`http://${HOST}:${httpPort}/big`, { maxBytes: 4 * 1024 * 1024 });
    expect(res.body.length).toBe(2 * 1024 * 1024);
  });

  it('gives up on a slowloris response at the deadline', async () => {
    const started = Date.now();
    const err = await failure(client()(`http://${HOST}:${httpPort}/slow`, { timeoutMs: 400 }));
    expect(err.code).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('gives up on a server that never answers', async () => {
    const err = await failure(client()(`http://${HOST}:${httpPort}/hang`, { timeoutMs: 300 }));
    expect(err.code).toBe('TIMEOUT');
  });

  it('counts DNS in the deadline', async () => {
    const never = () => new Promise<ResolvedAddress[]>(() => {});
    const err = await failure(
      client({}, never)(`http://${HOST}:${httpPort}/echo`, { timeoutMs: 200 })
    );
    expect(err.code).toBe('TIMEOUT');
  });

  it("stops when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const pending = client()(`http://${HOST}:${httpPort}/hang`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await failure(pending)).code).toBe('ABORTED');
  });
});

describe('createUrlCheck: the same rules, without connecting (#107)', () => {
  const check = (config: Partial<OutboundConfig> = {}) =>
    createUrlCheck(
      outboundPolicy({ allowHttp: false, extraPorts: [], allow: [], deny: [], ...config }),
      { resolve: resolver({ 'public.example.test': ['93.184.215.14'] }).resolve }
    );

  it('passes a public https URL and refuses what a request would refuse', async () => {
    await expect(check()('https://public.example.test/hook')).resolves.toBeUndefined();
    await expect(check()('https://1.1.1.1/hook')).resolves.toBeUndefined();
    const codes = async (url: string) => (await failure(check()(url))).code;
    expect(await codes('http://public.example.test/hook')).toBe('PROTOCOL_NOT_ALLOWED');
    expect(await codes('https://public.example.test:8443/hook')).toBe('PORT_NOT_ALLOWED');
    expect(await codes('https://u:p@public.example.test/hook')).toBe('CREDENTIALS_IN_URL');
    expect(await codes('https://hooks.example.test/hook')).toBe('ADDRESS_NOT_ALLOWED');
    expect(await codes('https://169.254.169.254/')).toBe('ADDRESS_NOT_ALLOWED');
    expect(await codes('https://nowhere.invalid/')).toBe('DNS_FAILED');
    expect(await codes('not a url')).toBe('INVALID_URL');
  });

  it('follows the allowlist like requests do', async () => {
    await expect(
      check({ allowHttp: true, extraPorts: [8190], allow: ['hooks.example.test'] })(
        'http://hooks.example.test:8190/in'
      )
    ).resolves.toBeUndefined();
  });
});
