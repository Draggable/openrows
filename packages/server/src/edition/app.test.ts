import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { testApp } from '../../test/helpers/app.js';
import type { Transaction } from '../db/index.js';
import { CountingUsageMeter, HookRegistry, noBilling, resolveEdition } from './index.js';
import type { EditionHooks } from './types.js';

const noTx = {} as Transaction;

// createApp and the edition: /health names it, handlers see its providers, and the
// `routes` hook adds routes through the registry only.
function cloud(hooks = new HookRegistry<EditionHooks>()) {
  return resolveEdition('cloud', {
    entitlements: {
      id: 'test-plans',
      forWorkspace: async () => ({
        plan: 'pro',
        planName: 'Pro',
        has: () => false,
        limit: () => 7,
      }),
    },
    billing: noBilling,
    usage: new CountingUsageMeter(),
    hooks,
  });
}

describe('createApp with an edition', () => {
  it('the OSS edition by default: /health says oss', async () => {
    const { app } = testApp();
    const res = await app.request('/health');
    expect(await res.json()).toMatchObject({ status: 'ok', edition: 'oss' });
  });

  it('/health says cloud for the hosted edition', async () => {
    const { app } = testApp({ edition: cloud() });
    expect(await (await app.request('/health')).json()).toMatchObject({ edition: 'cloud' });
  });

  it('the routes hook registers through the registry; handlers see the providers', async () => {
    const hooks = new HookRegistry<EditionHooks>();
    hooks.on('routes', (routes, ctx) => {
      expect(ctx.config.edition).toBe('oss');
      routes.public('GET', '/edition-test', async (c) => {
        // This provider reads nothing, so it needs no transaction.
        const entitlements = await c.var.edition.entitlements.forWorkspace('ws', noTx);
        return c.json({ plan: entitlements.plan, limit: entitlements.limit('recordsPerBase') });
      });
    });
    const { app, routes } = testApp({ edition: cloud(hooks) });
    expect(routes.entries.some((e) => e.path === '/edition-test')).toBe(true);
    const res = await app.request('/edition-test');
    expect(await res.json()).toEqual({ plan: 'pro', limit: 7 });
  });

  it('hook routes come before the client catch-all', async () => {
    const hooks = new HookRegistry<EditionHooks>();
    hooks.on('routes', (routes) => routes.public('GET', '/edition-test', (c) => c.text('hook')));
    const clientDir = mkdtempSync(join(tmpdir(), 'openrows-edition-'));
    onTestFinished(() => rmSync(clientDir, { recursive: true, force: true }));
    writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>client</title>');
    const { app } = testApp({ edition: cloud(hooks), config: { clientDir } });
    expect(await (await app.request('/edition-test')).text()).toBe('hook');
    expect(await (await app.request('/some/client/route')).text()).toContain('client');
  });

  it('a hook route that bypassed the registry fails createApp', () => {
    const hooks = new HookRegistry<EditionHooks>();
    hooks.on('routes', (routes) => {
      // The Hono app behind the registry, reached around it: no access rule.
      routes.app.get('/rogue', (c) => c.text('x'));
    });
    expect(() => testApp({ edition: cloud(hooks) })).toThrow(/outside the route registry/);
  });
});
