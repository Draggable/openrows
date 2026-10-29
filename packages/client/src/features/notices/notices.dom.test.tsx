import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../../router';
import { stubApi } from '../../test/fakeApi';
import { ME } from '../../test/me';

const NOW = '2026-10-25T10:00:00.000Z';

describe('the service notice banner (#78)', () => {
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
  afterEach(() => vi.unstubAllGlobals());

  it('shows a Terms update with its date and link, and dismisses it on the server', async () => {
    const api = stubApi(ME);
    api.workspaces.push({
      id: crypto.randomUUID(),
      name: 'Acme',
      role: 'owner',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const id = crypto.randomUUID();
    api.notices.push({
      id,
      kind: 'terms',
      title: "We're updating our Terms of Service",
      summary: 'Clearer rules for public forms.',
      url: 'https://openrows.io/terms',
      effectiveAt: '2099-12-01T00:00:00.000Z',
      publishedAt: NOW,
    });
    const router = createAppRouter({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    });
    render(<RouterProvider router={router} />);

    const banner = await screen.findByRole('region', { name: 'Service notice' });
    expect(banner.textContent).toContain("We're updating our Terms of Service");
    expect(banner.textContent).toContain('Takes effect on December 1, 2099.');
    expect(banner.textContent).toContain('Clearer rules for public forms.');
    const link = within(banner).getByRole('link', { name: 'Read the details' });
    expect(link.getAttribute('href')).toBe('https://openrows.io/terms');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');

    fireEvent.click(
      within(banner).getByRole('button', {
        name: "Dismiss notice: We're updating our Terms of Service",
      })
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Service notice' })).toBeNull()
    );
    expect(api.calls).toContain(`POST /api/me/notices/${id}/dismiss`);
    expect(api.notices).toEqual([]);
  });
});
