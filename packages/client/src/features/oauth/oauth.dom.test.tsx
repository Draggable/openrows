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

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('OAuth apps (#125)', () => {
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
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('registers an app and shows its client secret once', async () => {
    const api = stubApi(ME);
    renderApp('/settings');
    const section = await screen.findByRole('region', { name: 'Developer: OAuth apps' });
    expect(await within(section).findByText('No apps yet.')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'New app' }));
    const form = await screen.findByRole('dialog', { name: 'Register an OAuth app' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Acme Sync' } });
    fireEvent.change(within(form).getByLabelText('Redirect URIs'), {
      target: { value: 'https://acme.test/cb\n\nhttp://localhost:3000/cb' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Register app' }));
    const shown = await screen.findByRole('dialog', { name: 'Copy the client secret' });
    expect((within(shown).getByLabelText('Client secret') as HTMLInputElement).value).toMatch(
      /^or_secret_/
    );
    expect(api.oauthApps[0]?.['redirectUris']).toEqual([
      'https://acme.test/cb',
      'http://localhost:3000/cb',
    ]);
    fireEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    expect(await within(section).findByText('Acme Sync')).toBeTruthy();
    // The secret isn't in the list.
    expect(section.textContent).not.toContain('or_secret_');
  });

  it("refuses a redirect URI that isn't https or localhost", async () => {
    stubApi(ME);
    renderApp('/settings');
    const section = await screen.findByRole('region', { name: 'Developer: OAuth apps' });
    fireEvent.click(await within(section).findByRole('button', { name: 'New app' }));
    const form = await screen.findByRole('dialog', { name: 'Register an OAuth app' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Bad' } });
    fireEvent.change(within(form).getByLabelText('Redirect URIs'), {
      target: { value: 'http://acme.test/cb' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Register app' }));
    expect(await screen.findByText(/Use https/)).toBeTruthy();
  });

  it('lists authorized apps and revokes one', async () => {
    const api = stubApi(ME);
    api.authorizations.push({
      id: crypto.randomUUID(),
      app: { id: crypto.randomUUID(), name: 'Zap', homepageUrl: null },
      scopes: ['data.records:read'],
      workspaceIds: [crypto.randomUUID()],
      baseIds: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: null,
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/settings');
    const section = await screen.findByRole('region', { name: 'Integrations' });
    expect(await within(section).findByText('Zap')).toBeTruthy();
    expect(within(section).getByText(/data\.records:read · 1 workspace/)).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Revoke Zap' }));
    expect(await within(section).findByText('No apps have access.')).toBeTruthy();
  });

  it('asks for consent, then sends the browser back with the code', async () => {
    const api = stubApi(ME);
    const ws = await (
      await fetch('/api/workspaces', { method: 'POST', body: '{"name":"Acme"}' })
    ).json();
    await fetch(`/api/workspaces/${ws.id}/bases`, { method: 'POST', body: '{"name":"CRM"}' });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, search: '' });
    const search = new URLSearchParams({
      response_type: 'code',
      client_id: 'or_app_known',
      redirect_uri: 'https://acme.test/cb',
      scope: 'data.records:read schema.bases:read',
      state: 's-1',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    }).toString();
    window.location.search = `?${search}`;
    renderApp(`/oauth/authorize?${search}`);
    expect(
      await screen.findByRole('heading', { name: 'Allow Acme Sync to access your data?' })
    ).toBeTruthy();
    const asked = screen.getByRole('list', { name: 'Requested access' });
    expect(within(asked).getByText('data.records:read')).toBeTruthy();
    expect(screen.getByText('acme.test')).toBeTruthy();
    // Nothing picked yet: it says so.
    fireEvent.click(screen.getByRole('button', { name: 'Allow Acme Sync' }));
    expect(await screen.findByText('Pick at least one workspace or base.')).toBeTruthy();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'CRM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Allow Acme Sync' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign.mock.calls[0]?.[0]).toBe('https://acme.test/cb?code=the-code&state=s-1');
    expect(api.decisions[0]).toMatchObject({
      clientId: 'or_app_known',
      decision: 'allow',
      scope: 'data.records:read schema.bases:read',
      codeChallenge: CHALLENGE,
      workspaceIds: [],
      baseIds: [expect.any(String)],
    });
  });

  it("explains a request it can't show, without sending the browser anywhere", async () => {
    stubApi(ME);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, search: '?client_id=or_app_nope' });
    renderApp('/oauth/authorize?client_id=or_app_nope');
    expect(await screen.findByRole('heading', { name: "Can't connect this app" })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('unknown client_id');
    expect(screen.queryByRole('button', { name: 'Back to the app' })).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });
});
