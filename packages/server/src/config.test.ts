import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEV_DEFAULTS,
  HOSTED_AI_HOSTS,
  isInsecureSecret,
  loadConfig,
  loadEdition,
  loadOutboundConfig,
  loadWorkerConfig,
} from './config.js';

/** A complete, valid production environment. */
const PROD = {
  NODE_ENV: 'production',
  APP_URL: 'https://openrows.example.org',
  DATABASE_URL: 'postgresql://openrows:s3cure-Pg-pass@db:5432/openrows',
  ENCRYPTION_KEY: 'kQ4fW9zLp2Xv7NcR8sTg3HyB6mJd1ZaE',
  OIDC_ISSUER_URL: 'https://id.example.org/realms/openrows',
  OIDC_CLIENT_ID: 'openrows-app',
  OIDC_CLIENT_SECRET: 'oidc-client-s3cret-value',
  S3_ENDPOINT: 'http://minio:9000',
  S3_BUCKET: 'openrows',
  S3_ACCESS_KEY: 'openrows-app',
  S3_SECRET_KEY: 'minio-s3cret-value-123',
};

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  return [];
}

describe('loadConfig in development', () => {
  it('works with an empty environment', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      env: 'development',
      isProduction: false,
      port: 3000,
      logLevel: 'info',
      appUrl: DEV_DEFAULTS.APP_URL,
      trustProxy: false,
      trustProxyHops: 1,
      authRateLimit: 30,
      shareRateLimit: 600,
      formSubmitRateLimit: 20,
      turnstile: undefined,
      databaseUrl: DEV_DEFAULTS.DATABASE_URL,
      encryptionKey: DEV_DEFAULTS.ENCRYPTION_KEY,
      oidc: undefined,
      s3: undefined,
      redisUrl: undefined,
      eventBus: 'postgres',
      smtp: undefined,
      mailFrom: 'OpenRows <no-reply@openrows.io>',
    });
  });

  it('reads the Turnstile keys (#101), both or neither', () => {
    const config = loadConfig({
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      FORM_SUBMIT_RATE_LIMIT: '5',
    });
    expect(config.turnstile).toEqual({
      secretKey: '1x0000000000000000000000000000000AA',
      siteKey: '1x00000000000000000000AA',
    });
    expect(config.formSubmitRateLimit).toBe(5);
    expect(() => loadConfig({ TURNSTILE_SITE_KEY: '1x00000000000000000000AA' })).toThrow(
      /set both or neither/
    );
    expect(() => loadConfig({ TURNSTILE_SECRET_KEY: 'x' })).toThrow(/set both or neither/);
  });

  it('reads the status page URL (#137): http(s) only, unset by default', () => {
    expect(loadConfig({}).statusPageUrl).toBeUndefined();
    expect(loadConfig({ STATUS_PAGE_URL: '' }).statusPageUrl).toBeUndefined();
    expect(loadConfig({ STATUS_PAGE_URL: 'https://status.example.org' }).statusPageUrl).toBe(
      'https://status.example.org'
    );
    expect(loadConfig({ STATUS_PAGE_URL: 'http://localhost:8099' }).statusPageUrl).toBe(
      'http://localhost:8099'
    );
    for (const bad of ['javascript:alert(1)', 'status.example.org', 'ftp://status.example.org']) {
      expect(issuesOf({ STATUS_PAGE_URL: bad }), bad).toEqual([
        'STATUS_PAGE_URL: must be an http(s) URL',
      ]);
    }
  });

  it('reads SMTP, proxy hops and the auth rate limit', () => {
    const config = loadConfig({
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      TRUST_PROXY_HOPS: '2',
      AUTH_RATE_LIMIT: '5',
    });
    expect(config.smtp).toEqual({
      host: 'localhost',
      port: 1025,
      secure: false,
      requireTls: false,
      user: undefined,
      password: undefined,
    });
    expect(config.trustProxyHops).toBe(2);
    expect(config.authRateLimit).toBe(5);
  });

  it('reads SMTP_SECURE: implicit TLS, required STARTTLS or opportunistic (#136)', () => {
    const smtp = (SMTP_SECURE: string) =>
      loadConfig({ SMTP_HOST: 'mail.example.com', SMTP_SECURE }).smtp;
    expect(smtp('true')).toMatchObject({ secure: true, requireTls: false });
    expect(smtp('starttls')).toMatchObject({ secure: false, requireTls: true });
    expect(smtp('false')).toMatchObject({ secure: false, requireTls: false });
    expect(() => smtp('tls')).toThrow(/SMTP_SECURE/);
    expect(
      loadWorkerConfig({ SMTP_HOST: 'mail.example.com', SMTP_SECURE: 'starttls' }).smtp
    ).toEqual({
      host: 'mail.example.com',
      port: 587,
      secure: false,
      requireTls: true,
      user: undefined,
      password: undefined,
    });
  });

  it('refuses SMTP credentials without TLS in production, in the api and the worker (#136)', () => {
    const smtpIssues = (load: () => unknown) => {
      try {
        load();
        return [];
      } catch (err) {
        return (err as ConfigError).issues.filter((i) => i.startsWith('SMTP_'));
      }
    };
    const prod = {
      NODE_ENV: 'production',
      APP_URL: 'https://app.example.com',
      ENCRYPTION_KEY: 'k'.repeat(40),
      SMTP_HOST: 'mail.example.com',
      SMTP_USER: 'noreply@example.com',
      SMTP_PASSWORD: 'p'.repeat(24),
    };
    const message =
      'SMTP_SECURE: must be true (port 465) or starttls in production when SMTP_USER is set';
    expect(smtpIssues(() => loadWorkerConfig(prod))).toEqual([message]);
    expect(smtpIssues(() => loadConfig(prod))).toEqual([message]);
    for (const SMTP_SECURE of ['true', 'starttls']) {
      expect(smtpIssues(() => loadWorkerConfig({ ...prod, SMTP_SECURE }))).toEqual([]);
      expect(smtpIssues(() => loadConfig({ ...prod, SMTP_SECURE }))).toEqual([]);
    }
    // A relay without login (a local sidecar) may stay opportunistic.
    expect(
      smtpIssues(() => loadWorkerConfig({ ...prod, SMTP_USER: '', SMTP_PASSWORD: '' }))
    ).toEqual([]);
    expect(
      smtpIssues(() =>
        loadWorkerConfig({ ...prod, SMTP_SECURE: 'starttls', SMTP_PASSWORD: 'changeme' })
      )
    ).toEqual(['SMTP_PASSWORD: a default or placeholder value is not allowed in production']);
  });

  it("reads the API's rate limits (#104)", () => {
    expect(loadConfig({})).toMatchObject({
      apiRateLimits: { base: { perSecond: 5, burst: 10 }, token: { perSecond: 50, burst: 100 } },
      rateLimitStore: 'postgres',
    });
    const config = loadConfig({
      API_RATE_LIMIT_BASE: '0.5',
      API_RATE_LIMIT_BASE_BURST: '2',
      API_RATE_LIMIT_TOKEN: '20',
      API_RATE_LIMIT_TOKEN_BURST: '40',
      RATE_LIMIT_STORE: 'memory',
    });
    expect(config.apiRateLimits).toEqual({
      base: { perSecond: 0.5, burst: 2 },
      token: { perSecond: 20, burst: 40 },
    });
    expect(config.rateLimitStore).toBe('memory');
    expect(() => loadConfig({ API_RATE_LIMIT_BASE: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ API_RATE_LIMIT_TOKEN_BURST: '1.5' })).toThrow(ConfigError);
    expect(() => loadConfig({ RATE_LIMIT_STORE: 'redis' })).toThrow(ConfigError);
  });

  it('reads the outbound HTTP policy (#106): off by default, lists validated', () => {
    expect(loadConfig({}).outbound).toEqual({
      allowHttp: false,
      extraPorts: [],
      allow: [],
      deny: [],
    });
    const config = loadConfig({
      OUTBOUND_HTTP_ALLOW_HTTP: 'true',
      OUTBOUND_HTTP_PORTS: '5678, 8443,5678',
      OUTBOUND_HTTP_ALLOW: 'n8n.lan, 10.0.5.0/24 ,fd12::/64',
      OUTBOUND_HTTP_DENY: '*.example.com,203.0.114.7',
    });
    expect(config.outbound).toEqual({
      allowHttp: true,
      extraPorts: [5678, 8443],
      allow: ['n8n.lan', '10.0.5.0/24', 'fd12::/64'],
      deny: ['*.example.com', '203.0.114.7'],
    });
    expect(issuesOf({ OUTBOUND_HTTP_ALLOW: '10.0.0.0/33' })[0]).toMatch(/^OUTBOUND_HTTP_ALLOW:/);
    expect(issuesOf({ OUTBOUND_HTTP_DENY: 'http://x' })[0]).toMatch(/^OUTBOUND_HTTP_DENY:/);
    expect(issuesOf({ OUTBOUND_HTTP_PORTS: '0' })[0]).toMatch(/^OUTBOUND_HTTP_PORTS/);
    // The worker reads only these, without the rest of the config.
    expect(loadOutboundConfig({ OUTBOUND_HTTP_ALLOW: 'n8n.lan', DATABASE_URL: 'x' })).toEqual({
      allowHttp: false,
      extraPorts: [],
      allow: ['n8n.lan'],
      deny: [],
    });
    expect(() => loadOutboundConfig({ OUTBOUND_HTTP_DENY: '1.2.3.4/99' })).toThrow(ConfigError);
  });

  it("loads the worker's settings: the api's key, APP_URL, SMTP, outbound (#107)", () => {
    const dev = loadWorkerConfig({});
    expect(dev).toMatchObject({
      isProduction: false,
      appUrl: DEV_DEFAULTS.APP_URL,
      encryptionKey: DEV_DEFAULTS.ENCRYPTION_KEY,
      smtp: undefined,
    });
    const prod = loadWorkerConfig({
      NODE_ENV: 'production',
      APP_URL: 'https://app.example.com/',
      ENCRYPTION_KEY: 'k'.repeat(40),
      SMTP_HOST: 'smtp.example.com',
      OUTBOUND_HTTP_ALLOW: 'n8n.lan',
    });
    expect(prod).toMatchObject({
      isProduction: true,
      appUrl: 'https://app.example.com',
      encryptionKey: 'k'.repeat(40),
      smtp: { host: 'smtp.example.com', port: 587 },
      outbound: { allow: ['n8n.lan'] },
    });
    const refused = (env: Record<string, string>) => {
      try {
        loadWorkerConfig({ NODE_ENV: 'production', ...env });
        return [];
      } catch (err) {
        return (err as ConfigError).issues;
      }
    };
    expect(refused({ APP_URL: 'https://a.example.com' })).toEqual([
      'ENCRYPTION_KEY: required in production',
    ]);
    expect(
      refused({ APP_URL: 'http://a.example.com', ENCRYPTION_KEY: DEV_DEFAULTS.ENCRYPTION_KEY })
    ).toEqual([
      'APP_URL: must use https in production',
      'ENCRYPTION_KEY: a default or placeholder value is not allowed in production',
    ]);
  });

  it('reads EDITION (#127): oss by default, cloud, nothing else', () => {
    expect(loadConfig({}).edition).toBe('oss');
    expect(loadConfig({ EDITION: '' }).edition).toBe('oss');
    expect(loadConfig({ EDITION: 'cloud' }).edition).toBe('cloud');
    expect(() => loadConfig({ EDITION: 'enterprise' })).toThrow(ConfigError);
    expect(loadEdition({})).toBe('oss');
    expect(loadEdition({ EDITION: 'cloud' })).toBe('cloud');
    expect(() => loadEdition({ EDITION: 'ee' })).toThrow(/EDITION/);
  });

  it('reads the AI providers (#148)', () => {
    expect(loadConfig({}).ai).toEqual({
      instance: undefined,
      allowedHosts: undefined,
      timeoutMs: 60_000,
    });
    // A key without a model doesn't turn AI on.
    expect(loadConfig({ AI_API_KEY: 'sk-abc' }).ai.instance).toBeUndefined();
    expect(
      loadConfig({ AI_MODEL: 'llama3.1', AI_BASE_URL: 'http://ollama:11434/v1/' }).ai.instance
    ).toEqual({ baseUrl: 'http://ollama:11434/v1', model: 'llama3.1', apiKey: undefined });
    expect(
      loadConfig({ AI_ALLOWED_HOSTS: 'API.openai.com, *.openrouter.ai,api.openai.com' }).ai
        .allowedHosts
    ).toEqual(['api.openai.com', '*.openrouter.ai']);
    // The hosted service only reaches the providers it lists, unless told otherwise.
    expect(loadConfig({ EDITION: 'cloud' }).ai.allowedHosts).toEqual([...HOSTED_AI_HOSTS]);
    expect(loadWorkerConfig({ EDITION: 'cloud' }).ai.allowedHosts).toEqual([...HOSTED_AI_HOSTS]);
    expect(
      loadConfig({ EDITION: 'cloud', AI_ALLOWED_HOSTS: 'api.openai.com' }).ai.allowedHosts
    ).toEqual(['api.openai.com']);
    expect(() => loadConfig({ AI_BASE_URL: 'ftp://x' })).toThrow(ConfigError);
    expect(() => loadConfig({ AI_ALLOWED_HOSTS: 'not a host' })).toThrow(ConfigError);
    expect(issuesOf({ ...PROD, AI_MODEL: 'm', AI_API_KEY: 'change-me' })).toEqual([
      'AI_API_KEY: a default or placeholder value is not allowed in production',
    ]);
  });

  it('picks the realtime event bus (#87)', () => {
    expect(loadConfig({ EVENT_BUS: 'redis' }).eventBus).toBe('redis');
    expect(() => loadConfig({ EVENT_BUS: 'kafka' })).toThrow(ConfigError);
  });

  it('reads system admins as lowercased, deduplicated emails (#91)', () => {
    expect(loadConfig({}).systemAdmins).toEqual([]);
    expect(
      loadConfig({ OPENROWS_SYSTEM_ADMINS: ' Ops@Example.com,ops@example.com, ,b@x.io' })
        .systemAdmins
    ).toEqual(['ops@example.com', 'b@x.io']);
    expect(() => loadConfig({ OPENROWS_SYSTEM_ADMINS: 'not-an-email' })).toThrow(ConfigError);
  });

  it('is silent under test by default', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).logLevel).toBe('silent');
    expect(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  it('parses numbers, booleans and URLs', () => {
    const config = loadConfig({
      PORT: '8080',
      TRUST_PROXY: 'true',
      APP_URL: 'http://localhost:4173/some/path',
      REDIS_URL: 'redis://localhost:6379',
    });
    expect(config.port).toBe(8080);
    expect(config.trustProxy).toBe(true);
    expect(config.appUrl).toBe('http://localhost:4173');
    expect(config.redisUrl).toBe('redis://localhost:6379');
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ PORT: '', S3_ENDPOINT: ' ', REDIS_URL: '' })).toMatchObject({
      port: 3000,
      s3: undefined,
      redisUrl: undefined,
    });
  });

  it('rejects malformed values', () => {
    expect(issuesOf({ PORT: 'abc', TRUST_PROXY: 'maybe', APP_URL: 'nope' })).toEqual([
      expect.stringMatching(/^PORT: /),
      expect.stringMatching(/^APP_URL: /),
      expect.stringMatching(/^TRUST_PROXY: /),
    ]);
  });

  it('accepts S3 and OIDC when complete, and rejects a half-configured group', () => {
    const { NODE_ENV: _, ...complete } = PROD;
    const config = loadConfig(complete);
    expect(config.s3).toEqual({
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      bucket: 'openrows',
      accessKey: 'openrows-app',
      secretKey: 'minio-s3cret-value-123',
      publicUrl: undefined,
    });
    expect(config.oidc?.scopes).toBe('openid email profile');

    expect(issuesOf({ S3_ENDPOINT: 'http://localhost:9000' })).toEqual([
      'S3_BUCKET: required when S3_ENDPOINT is set',
      'S3_ACCESS_KEY: required when S3_ENDPOINT is set',
      'S3_SECRET_KEY: required when S3_ENDPOINT is set',
    ]);
    expect(issuesOf({ OIDC_CLIENT_ID: 'x' })).toHaveLength(2);
  });
});

describe('loadConfig in production', () => {
  it('accepts a complete environment', () => {
    const config = loadConfig(PROD);
    expect(config.isProduction).toBe(true);
    expect(config.databaseUrl).toBe(PROD.DATABASE_URL);
    expect(config.s3?.bucket).toBe('openrows');
    expect(config.oidc?.clientId).toBe('openrows-app');
  });

  it('fails fast when secrets are missing', () => {
    expect(issuesOf({ NODE_ENV: 'production' })).toEqual(
      expect.arrayContaining([
        'APP_URL: required in production',
        'DATABASE_URL: required in production',
        'ENCRYPTION_KEY: required in production',
        'OIDC_CLIENT_SECRET: required in production',
        'S3_SECRET_KEY: required in production',
      ])
    );
  });

  it.each([
    ['ENCRYPTION_KEY', DEV_DEFAULTS.ENCRYPTION_KEY],
    ['ENCRYPTION_KEY', 'please-change-this-secret-in-production'],
    ['OIDC_CLIENT_SECRET', 'change-me'],
    ['S3_ACCESS_KEY', 'minioadmin'],
    ['S3_SECRET_KEY', 'minioadmin'],
    ['DATABASE_URL', DEV_DEFAULTS.DATABASE_URL],
    ['DATABASE_URL', 'postgresql://openrows@db:5432/openrows'],
    ['REDIS_URL', 'redis://:changeme@redis:6379'],
    ['SMTP_PASSWORD', 'changeme'],
  ])('rejects the default %s %s', (key, value) => {
    const issues = issuesOf({ ...PROD, [key]: value });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(new RegExp(`^${key}: `));
  });

  it('requires HTTPS for public URLs', () => {
    expect(
      issuesOf({
        ...PROD,
        APP_URL: 'http://openrows.example.org',
        OIDC_ISSUER_URL: 'http://id',
        STATUS_PAGE_URL: 'http://status.example.org',
      })
    ).toEqual([
      'APP_URL: must use https in production',
      'OIDC_ISSUER_URL: must use https in production',
      'STATUS_PAGE_URL: must use https in production',
    ]);
  });

  it('reports every problem in one error message', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      /Invalid configuration:\n {2}- .*ENCRYPTION_KEY: required in production/s
    );
  });
});

describe('isInsecureSecret', () => {
  it('flags defaults and placeholders but not real secrets', () => {
    expect(isInsecureSecret('MinioAdmin')).toBe(true);
    expect(isInsecureSecret('change_me_please')).toBe(true);
    expect(isInsecureSecret('Zq81bA9xR2mT7vYwP0s')).toBe(false);
  });
});
