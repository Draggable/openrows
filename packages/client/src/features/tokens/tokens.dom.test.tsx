import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../../router';
import { stubApi } from '../../test/fakeApi';
import { ME } from '../../test/me';

function renderApp(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe('Settings: personal access tokens (#102)', () => {
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

  it('creates a token, shows its secret once, lists and revokes it', async () => {
    const api = stubApi(ME);
    const ws = await (
      await fetch('/api/workspaces', { method: 'POST', body: '{"name":"Acme"}' })
    ).json();
    await fetch(`/api/workspaces/${ws.id}/bases`, { method: 'POST', body: '{"name":"CRM"}' });
    renderApp('/settings');
    const section = await screen.findByRole('region', {
      name: 'Developer: personal access tokens',
    });
    expect(await within(section).findByText('No tokens yet.')).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'Create token' }));
    const form = await screen.findByRole('dialog', { name: 'Create a personal access token' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Sync' } });
    fireEvent.click(within(form).getByRole('checkbox', { name: /data\.records:read/ }));
    fireEvent.click(await within(form).findByRole('checkbox', { name: 'CRM' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create token' }));

    const shown = await screen.findByRole('dialog', { name: 'Copy your new token' });
    expect((within(shown).getByLabelText('Token') as HTMLInputElement).value).toMatch(
      /^or_pat_\w{12}_s{43}$/
    );
    const post = api.fetch.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/me/tokens') && init?.method === 'POST'
    );
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      name: 'Sync',
      scopes: ['data.records:read'],
      workspaceIds: [],
      baseIds: [expect.any(String)],
      expiresInDays: 90,
    });
    fireEvent.click(within(shown).getByRole('button', { name: 'Done' }));

    const row = await within(section).findByRole('listitem');
    expect(row.textContent).toContain('Sync');
    expect(row.textContent).toContain('Never used');
    // Requests per day: the totals, and each day in a table.
    expect(within(row).getByText('12 requests today · 27 in 7 days')).toBeTruthy();
    const perDay = within(row).getByRole('table', { name: 'Requests per day (UTC) with Sync' });
    expect(within(perDay).getAllByRole('row')).toHaveLength(7);
    expect(row.textContent).not.toContain('s'.repeat(43));
    vi.stubGlobal('confirm', () => true);
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke Sync' }));
    await waitFor(() => expect(within(section).queryByRole('listitem')).toBeNull());
    expect(api.tokens).toEqual([]);
  });

  it('refuses to create a token without scopes or access', async () => {
    const api = stubApi(ME);
    renderApp('/settings');
    const section = await screen.findByRole('region', {
      name: 'Developer: personal access tokens',
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Create token' }));
    const form = await screen.findByRole('dialog', { name: 'Create a personal access token' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Sync' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create token' }));
    expect(await screen.findByText('Pick at least one scope.')).toBeTruthy();
    expect(api.calls).not.toContain('POST /api/me/tokens');
  });
});
