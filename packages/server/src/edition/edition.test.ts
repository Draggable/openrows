import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../db/index.js';
import {
  CountingUsageMeter,
  EditionError,
  FEATURES,
  HookRegistry,
  LIMITS,
  MAX_HANDLERS_PER_HOOK,
  noBilling,
  ossEdition,
  ossEntitlements,
  resolveEdition,
  USAGE_METRICS,
} from './index.js';
import type { EditionProviders } from './types.js';

const hosted = (): EditionProviders => ({
  entitlements: { id: 'hosted', forWorkspace: ossEntitlements.forWorkspace },
  billing: { ...noBilling, id: 'hosted-billing' },
  usage: new CountingUsageMeter(),
});

describe('resolveEdition', () => {
  it('oss without providers: the OSS edition', () => {
    const edition = resolveEdition('oss');
    expect(edition.name).toBe('oss');
    expect(edition.entitlements.id).toBe('oss');
    expect(edition.billing).toBe(noBilling);
    expect(edition.usage.id).toBe('counting');
  });

  it('cloud refuses to start without the ee providers', () => {
    expect(() => resolveEdition('cloud')).toThrow(EditionError);
    expect(() => resolveEdition('cloud')).toThrow(/EDITION=cloud needs the hosted/);
  });

  it('oss refuses providers an ee entry point brought', () => {
    expect(() => resolveEdition('oss', hosted())).toThrow(/EDITION=oss, but/);
  });

  it('cloud with providers: those providers, and a hook registry even without one', () => {
    const providers = hosted();
    const edition = resolveEdition('cloud', providers);
    expect(edition.name).toBe('cloud');
    expect(edition.entitlements).toBe(providers.entitlements);
    expect(edition.billing.id).toBe('hosted-billing');
    expect(edition.usage).toBe(providers.usage);
    expect(edition.hooks.count('routes')).toBe(0);
    const hooks = new HookRegistry<{ routes: () => void }>();
    expect(resolveEdition('cloud', { ...providers, hooks }).hooks).toBe(hooks);
  });

  it('each OSS edition gets its own meter and hooks', () => {
    const a = ossEdition();
    const b = ossEdition();
    expect(a.usage).not.toBe(b.usage);
    expect(a.hooks).not.toBe(b.hooks);
  });
});

describe('the OSS providers', () => {
  it('entitlements: every feature on, every limit unlimited', async () => {
    const e = await ossEntitlements.forWorkspace('ws', {} as Transaction);
    expect(e.plan).toBe('self-hosted');
    for (const feature of FEATURES) expect(e.has(feature), feature).toBe(true);
    for (const limit of LIMITS) expect(e.limit(limit), limit).toBeNull();
  });

  it('billing: none', async () => {
    expect(noBilling.enabled).toBe(false);
    expect(noBilling.offers()).toEqual([]);
    expect(noBilling.checkout).toBeUndefined();
    expect(await noBilling.upgradeUrl('ws')).toBeNull();
  });

  it('the meter counts per workspace and metric and never blocks', async () => {
    const meter = new CountingUsageMeter();
    await meter.record('a', 'apiCalls');
    await meter.record('a', 'apiCalls', 4);
    await meter.record('a', 'records', 10);
    await meter.record('b', 'apiCalls', 2);
    expect(meter.used('a', 'apiCalls')).toBe(5);
    expect(meter.used('a', 'records')).toBe(10);
    expect(meter.used('b', 'apiCalls')).toBe(2);
    expect(meter.used('c', 'apiCalls')).toBe(0);
    for (const metric of USAGE_METRICS) {
      expect(await meter.check('a', metric, 1e12)).toEqual({ allowed: true });
    }
  });

  it('the meter ignores amounts that are not positive and finite', async () => {
    const meter = new CountingUsageMeter();
    for (const amount of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      await meter.record('a', 'apiCalls', amount);
    }
    expect(meter.used('a', 'apiCalls')).toBe(0);
  });

  it('the meter keeps at most maxWorkspaces, dropping the least recently counted', async () => {
    const meter = new CountingUsageMeter(2);
    await meter.record('a', 'apiCalls');
    await meter.record('b', 'apiCalls');
    await meter.record('a', 'apiCalls');
    await meter.record('c', 'apiCalls');
    expect(meter.used('a', 'apiCalls')).toBe(2);
    expect(meter.used('b', 'apiCalls')).toBe(0);
    expect(meter.used('c', 'apiCalls')).toBe(1);
  });
});

describe('HookRegistry', () => {
  type Hooks = { greet: (name: string, out: string[]) => void; other: () => void };

  it('runs handlers in registration order with the arguments', () => {
    const hooks = new HookRegistry<Hooks>();
    hooks.on('greet', (name, out) => out.push(`a:${name}`));
    hooks.on('greet', (name, out) => out.push(`b:${name}`));
    const out: string[] = [];
    hooks.run('greet', 'x', out);
    expect(out).toEqual(['a:x', 'b:x']);
    expect(hooks.count('greet')).toBe(2);
    expect(hooks.count('other')).toBe(0);
    hooks.run('other');
  });

  it('the returned function removes the handler', () => {
    const hooks = new HookRegistry<Hooks>();
    const handler = vi.fn();
    const off = hooks.on('other', handler);
    off();
    off();
    hooks.run('other');
    expect(handler).not.toHaveBeenCalled();
    expect(hooks.count('other')).toBe(0);
  });

  it('a throwing handler stops the run', () => {
    const hooks = new HookRegistry<Hooks>();
    const after = vi.fn();
    hooks.on('other', () => {
      throw new Error('boom');
    });
    hooks.on('other', after);
    expect(() => hooks.run('other')).toThrow('boom');
    expect(after).not.toHaveBeenCalled();
  });

  it(`caps a hook at ${MAX_HANDLERS_PER_HOOK} handlers`, () => {
    const hooks = new HookRegistry<Hooks>();
    for (let i = 0; i < MAX_HANDLERS_PER_HOOK; i++) hooks.on('other', () => {});
    expect(() => hooks.on('other', () => {})).toThrow(/too many handlers/);
  });
});
