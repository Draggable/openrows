import { describe, expect, it } from 'vitest';
import { DEV_DEFAULTS } from '../config.js';
import { migrationSettings } from './index.js';

describe('migrationSettings', () => {
  it('uses the dev owner and the dev openrows_app password when nothing is configured', () => {
    expect(migrationSettings({})).toEqual({
      url: DEV_DEFAULTS.MIGRATION_DATABASE_URL,
      appPassword: DEV_DEFAULTS.APP_DB_PASSWORD,
    });
  });

  it('prefers MIGRATION_DATABASE_URL, falls back to DATABASE_URL, sets no password by default', () => {
    const url = 'postgresql://owner:pw@db/openrows';
    expect(migrationSettings({ MIGRATION_DATABASE_URL: url, DATABASE_URL: 'x' })).toEqual({
      url,
      appPassword: undefined,
    });
    expect(migrationSettings({ DATABASE_URL: url, OPENROWS_APP_DB_PASSWORD: 's3cret-Pw' })).toEqual(
      {
        url,
        appPassword: 's3cret-Pw',
      }
    );
  });

  it('requires a URL and a non-default password in production', () => {
    expect(() => migrationSettings({ NODE_ENV: 'production' })).toThrow(/required in production/);
    expect(() =>
      migrationSettings({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://owner:pw@db/openrows',
        OPENROWS_APP_DB_PASSWORD: DEV_DEFAULTS.APP_DB_PASSWORD,
      })
    ).toThrow(/OPENROWS_APP_DB_PASSWORD/);
  });
});
