import type { BillingOffer, WorkspaceBilling } from '@openrows/shared';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router';
import { stubApi } from '../test/fakeApi';
import { ME } from '../test/me';

const NOW = '2026-10-28T10:00:00.000Z';

function renderApp(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const offer = (plan: string, name: string, amount: number, annual: number): BillingOffer => ({
  plan,
  name,
  intervals: ['month', 'year'],
  price: { amount, annual, currency: 'USD', per: 'editor-month' },
});

const BILLING = (workspaceId: string, offers: BillingOffer[]): WorkspaceBilling => ({
  workspaceId,
  enabled: true,
  plan: { id: 'free', name: 'Free' },
  subscription: null,
  offers,
  portal: false,
  editors: 2,
  manage: true,
});

describe('the Billing page plan picker (#131, annual prices)', () => {
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

  function seed(offers: BillingOffer[]) {
    const api = stubApi(ME);
    const ws = {
      id: crypto.randomUUID(),
      name: 'Acme',
      role: 'owner',
      createdAt: NOW,
      updatedAt: NOW,
    };
    api.workspaces.push(ws);
    api.billing[ws.id] = BILLING(ws.id, offers);
    renderApp(`/w/${ws.id}/billing`);
    return ws;
  }

  it("shows the server's annual prices, a month of them and 2 months free", async () => {
    seed([offer('pro', 'Pro', 10, 100), offer('business', 'Business', 24, 240)]);
    const plans = await screen.findByRole('region', { name: 'Plans' });
    expect(within(plans).getByText('$10 per editor / month')).toBeTruthy();
    expect(within(plans).getByText('$24 per editor / month')).toBeTruthy();
    const annual = within(plans).getByRole('radio', { name: /Annual/ });
    expect(annual.parentElement?.textContent).toBe('Annual2 months free');
    expect(within(plans).getByRole('radio', { name: 'Monthly' })).toBeTruthy();

    fireEvent.click(annual);
    const prices = within(plans)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.text-small')?.textContent);
    // The toggle says the saving both plans share; each plan its price a month.
    expect(prices).toEqual([
      '$100 per editor / year · $8.33 / month',
      '$240 per editor / year · $20 / month',
    ]);
  });

  it('derives the saving from the prices: another annual price says something else', async () => {
    seed([offer('pro', 'Pro', 10, 110), offer('business', 'Business', 24, 288)]);
    const plans = await screen.findByRole('region', { name: 'Plans' });
    const annual = within(plans).getByRole('radio', { name: /Annual/ });
    expect(annual.parentElement?.textContent).toBe('AnnualSave up to 8%');
    fireEvent.click(annual);
    const prices = within(plans)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('.text-small')?.textContent);
    expect(prices).toEqual([
      '$110 per editor / year · $9.17 / month, 1 month free',
      '$288 per editor / year · $24 / month',
    ]);
  });
});
