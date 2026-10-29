import { describe, expect, it } from 'vitest';
import { TEST_KEY } from '../test/helpers.js';
import { parseArgs } from './cli.js';
import { ConfigError, isInsecureUrl, loadConfig, redact } from './config.js';

describe('loadConfig', () => {
  it('reads the token and the URL', () => {
    expect(loadConfig({ OPENROWS_API_KEY: ` ${TEST_KEY} ` })).toEqual({
      apiKey: TEST_KEY,
      url: 'https://app.openrows.io',
    });
    for (const url of ['https://rows.example.com/', 'https://rows.example.com/api/v1']) {
      expect(loadConfig({ OPENROWS_API_KEY: TEST_KEY, OPENROWS_URL: url }).url).toBe(
        'https://rows.example.com'
      );
    }
  });

  it('refuses a missing or malformed token, and odd URLs, without echoing the token', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ OPENROWS_API_KEY: 'pat123.secret' })).toThrow(/or_pat_/);
    for (const url of ['ftp://x', 'not a url', 'https://u:p@x.example', 'https://x.example/?a=1']) {
      expect(() => loadConfig({ OPENROWS_API_KEY: TEST_KEY, OPENROWS_URL: url })).toThrow(
        ConfigError
      );
    }
  });

  it('scrubs tokens from text', () => {
    expect(redact(`token ${TEST_KEY} here`)).toBe('token or_pat_[redacted] here');
    expect(redact('custom secret', 'secret')).toBe('custom or_pat_[redacted]');
  });

  it('warns about plain http to another host only', () => {
    expect(isInsecureUrl('http://rows.example.com')).toBe(true);
    expect(isInsecureUrl('http://localhost:8180')).toBe(false);
    expect(isInsecureUrl('https://rows.example.com')).toBe(false);
  });
});

describe('parseArgs', () => {
  it('serves without arguments and refuses unknown ones', () => {
    expect(parseArgs([])).toBe('serve');
    expect(parseArgs(['--help'])).toBe('help');
    expect(parseArgs(['-v'])).toBe('version');
    expect(parseArgs([TEST_KEY])).toEqual({ error: expect.stringContaining('or_pat_[redacted]') });
  });
});
