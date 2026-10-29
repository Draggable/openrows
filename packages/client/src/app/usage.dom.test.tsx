import type { WorkspaceUsage } from '@openrows/shared';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router';
import { stubApi } from '../test/fakeApi';
import { ME } from '../test/me';

const NOW = '2026-10-25T10:00:00.000Z';

function renderApp(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const FREE = (workspaceId: string, baseId: string): WorkspaceUsage => ({
  workspaceId,
  plan: { id: 'free', name: 'Free' },
  period: { start: '2026-10-01', end: '2026-11-01' },
  bases: [{ baseId, name: 'Roadmap', records: 850, limit: 1000 }],
  attachmentBytes: { used: 1536, limit: 1024 ** 3 },
  automationRuns: { used: 250, limit: 250 },
  apiCalls: { used: 12, limit: 2000 },
  editors: { used: 2, limit: 5 },
  aiCredits: null,
  revisionHistoryDays: 14,
  features: {
    removeBranding: false,
    personalViews: false,
    lockedViews: false,
    editPermissions: false,
    sso: false,
    scim: false,
    auditLogExport: false,
    adminConsole: false,
    dataResidency: false,
  },
  upgradeUrl: 'https://openrows.io/pricing',
});

describe('the workspace usage page (#128)', () => {
  beforeAll(() => {
    window.matchMedia ??= ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function seed() {
    const api = stubApi(ME);
    const ws = {
      id: crypto.randomUUID(),
      name: 'Acme',
      role: 'editor',
      createdAt: NOW,
      updatedAt: NOW,
    };
    api.workspaces.push(ws);
    return { api, ws };
  }

  it('shows the plan, every meter against its limit, records per base and the features', async () => {
    const { api, ws } = seed();
    api.usage[ws.id] = FREE(ws.id, crypto.randomUUID());
    renderApp(`/w/${ws.id}/usage`);

    expect(await screen.findByRole('heading', { name: 'Free plan' })).toBeTruthy();
    expect(screen.getByText(/count for October 2026 \(UTC\)/)).toBeTruthy();
    const meter = (name: string) => screen.getByRole('meter', { name });
    expect(meter('Files').getAttribute('aria-valuetext')).toBe('1.5 KB / 1.0 GB');
    expect(meter('Automation runs in October 2026').getAttribute('value')).toBe('250');
    expect(meter('API calls in October 2026').getAttribute('aria-valuetext')).toBe('12 / 2,000');
    expect(meter('Editors').getAttribute('aria-valuetext')).toBe('2 / 5');
    expect(meter('Roadmap').getAttribute('aria-valuetext')).toBe('850 / 1,000');
    // Full meters turn red, nearly full ones amber.
    const bar = (name: string) => meter(name).nextElementSibling?.firstElementChild;
    expect(bar('Automation runs in October 2026')?.className).toContain('bg-danger');
    expect(bar('Roadmap')?.className).toContain('bg-warning');
    expect(bar('Editors')?.className).toContain('bg-primary');
    expect(screen.getByText(/record history: 2 weeks/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See members' }).getAttribute('href')).toBe(
      `/w/${ws.id}/members`
    );
    const features = screen.getByRole('region', { name: 'Features' });
    expect(within(features).getByText('Locked views').parentElement?.textContent).toContain(
      'not included'
    );
  });

  it("shows the month's AI credits only when the server has an AI provider (#151)", async () => {
    const { api, ws } = seed();
    api.usage[ws.id] = FREE(ws.id, crypto.randomUUID());
    renderApp(`/w/${ws.id}/usage`);
    await screen.findByRole('heading', { name: 'Free plan' });
    expect(screen.queryByRole('meter', { name: 'AI credits in October 2026' })).toBeNull();
  });

  it('shows the AI credits meter with its reset and how credits count (#151)', async () => {
    const { api, ws } = seed();
    api.usage[ws.id] = { ...FREE(ws.id, crypto.randomUUID()), aiCredits: { used: 85, limit: 100 } };
    renderApp(`/w/${ws.id}/usage`);
    const meter = await screen.findByRole('meter', { name: 'AI credits in October 2026' });
    expect(meter.getAttribute('aria-valuetext')).toBe('85 / 100');
    expect(screen.getByText(/count for October 2026 \(UTC\)/).textContent).toContain('AI credits');
    expect(screen.getByText(/1 credit per 2,000 tokens/)).toBeTruthy();
    expect(screen.getAllByText('Resets November 1')).toHaveLength(3);
  });

  it('says when monthly limits reset, which meters are full or nearly, and who upgrades (#130)', async () => {
    const { api, ws } = seed();
    api.usage[ws.id] = FREE(ws.id, crypto.randomUUID());
    renderApp(`/w/${ws.id}/usage`);
    await screen.findByRole('heading', { name: 'Free plan' });
    expect(screen.getAllByText('Resets November 1')).toHaveLength(2);
    expect(screen.getAllByTestId('meter-status').map((e) => e.textContent)).toEqual([
      'Limit reached',
      '80% or more used',
    ]);
    // An editor: no button, the owners upgrade.
    expect(screen.queryByRole('link', { name: 'Upgrade' })).toBeNull();
    expect(screen.getByText('Workspace owners can upgrade the plan.')).toBeTruthy();
  });

  it("the owner's Upgrade button goes to the pricing page; none self-hosted", async () => {
    const { api, ws } = seed();
    ws.role = 'owner';
    api.usage[ws.id] = FREE(ws.id, crypto.randomUUID());
    renderApp(`/w/${ws.id}/usage`);
    const upgrade = await screen.findByRole('link', { name: 'Upgrade' });
    expect(upgrade.getAttribute('href')).toBe('https://openrows.io/pricing');
    expect(upgrade.getAttribute('rel')).toContain('noopener');
  });

  it('the workspace banner: owners and creators, at 80% and 100%, dismissible (#130)', async () => {
    const { api, ws } = seed();
    ws.role = 'creator';
    api.usage[ws.id] = FREE(ws.id, crypto.randomUUID());
    renderApp(`/w/${ws.id}`);
    const banner = await screen.findByTestId('usage-banner');
    expect(banner.getAttribute('data-level')).toBe('full');
    expect(banner.textContent).toContain('A plan limit is reached');
    expect(banner.textContent).toContain("This month's 250 automation runs are used up.");
    expect(banner.textContent).toContain(
      'Roadmap has 850 of the 1,000 records its plan allows (85%).'
    );
    // A creator sees usage, not the owners' Upgrade.
    expect(within(banner).getByRole('link', { name: 'See usage' }).getAttribute('href')).toBe(
      `/w/${ws.id}/usage`
    );
    expect(within(banner).queryByRole('link', { name: 'Upgrade' })).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('usage-banner')).toBeNull();
  });

  it('no banner for editors', async () => {
    const { api, ws } = seed();
    api.usage[ws.id] = FREE(ws.id, crypto.randomUUID());
    renderApp(`/w/${ws.id}`);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByTestId('usage-banner')).toBeNull();
    expect(api.calls.some((c) => c.includes('/usage'))).toBe(false);
  });

  it('self-hosted: no limits, no bars', async () => {
    const { api, ws } = seed();
    const u = FREE(ws.id, crypto.randomUUID());
    const none = { limit: null };
    api.usage[ws.id] = {
      ...u,
      plan: { id: 'self-hosted', name: 'Self-hosted' },
      bases: u.bases.map((b) => ({ ...b, limit: null })),
      attachmentBytes: { ...u.attachmentBytes, ...none },
      automationRuns: { ...u.automationRuns, ...none },
      apiCalls: { ...u.apiCalls, ...none },
      editors: { ...u.editors, ...none },
      revisionHistoryDays: null,
      features: Object.fromEntries(Object.keys(u.features).map((f) => [f, true])),
    };
    renderApp(`/w/${ws.id}/usage`);
    expect(await screen.findByRole('heading', { name: 'Self-hosted plan' })).toBeTruthy();
    expect(screen.getByText(/No limits on records/)).toBeTruthy();
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(screen.getByText('850')).toBeTruthy();
  });

  it('is in the workspace menu', async () => {
    const { api, ws } = seed();
    api.usage[ws.id] = FREE(ws.id, crypto.randomUUID());
    const router = renderApp(`/w/${ws.id}/members`);
    fireEvent.pointerDown(await screen.findByRole('button', { name: /Acme/ }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Usage and plan' }));
    expect(await screen.findByRole('heading', { name: 'Free plan' })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/w/${ws.id}/usage`);
  });
});
