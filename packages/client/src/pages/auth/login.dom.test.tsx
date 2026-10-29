import type { AuthErrorCode } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';

/** The server's public `/auth/providers` answer, or a failure. */
function stubProviders(body: unknown, status = 200) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function renderLogin(props: { error?: AuthErrorCode; returnTo?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LoginPage {...props} />
    </QueryClientProvider>
  );
}

describe('the sign-in page', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers "Sign in with SSO": /auth/login with the work email (#158)', () => {
    stubProviders({ providers: [], statusPageUrl: null });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    renderLogin({ returnTo: '/b/1' });
    expect(screen.queryByLabelText('Work email')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with SSO' }));
    const email = screen.getByLabelText('Work email') as HTMLInputElement;
    expect(email.type).toBe('email');
    fireEvent.change(email, { target: { value: ' ada@acme.com ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with SSO' }));
    expect(assign).toHaveBeenCalledWith('/auth/login?email=ada%40acme.com&returnTo=%2Fb%2F1');
  });

  it('opens the SSO form and explains when the domain requires single sign-on', () => {
    stubProviders({ providers: [], statusPageUrl: null });
    renderLogin({ error: 'sso_required' });
    expect(screen.getByRole('alert').textContent).toMatch(/requires single sign-on/);
    expect(screen.getByLabelText('Work email')).toBeTruthy();
  });

  it("links the instance's status page in the footer (#137)", async () => {
    const fetch = stubProviders({
      providers: ['github'],
      statusPageUrl: 'https://status.example.org',
    });
    renderLogin();
    const status = await screen.findByRole('link', { name: 'Status' });
    expect(status.getAttribute('href')).toBe('https://status.example.org/');
    expect(status.getAttribute('target')).toBe('_blank');
    expect(status.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Continue with GitHub' })).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/providers$/), {
      credentials: 'include',
    });
  });

  it('shows no status link without a status page, or when the server is down', async () => {
    const fetch = stubProviders({ providers: [], statusPageUrl: null });
    renderLogin();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByRole('link', { name: 'API docs' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Status' })).toBeNull();
  });

  it('never links anything but an http(s) URL', async () => {
    const fetch = stubProviders({ providers: [], statusPageUrl: 'javascript:alert(1)' });
    renderLogin();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('link', { name: 'Status' })).toBeNull();
  });
});
