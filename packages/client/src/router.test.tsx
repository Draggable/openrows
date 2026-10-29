import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from './router';
import { ME, stubMe } from './test/me';

async function render(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  await router.load();
  return { router, html: renderToString(<RouterProvider router={router} />) };
}

describe('router', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends signed-out visitors of / to /login', async () => {
    stubMe(null);
    const { router, html } = await render('/');
    expect(router.state.location.pathname).toBe('/login');
    expect(html).toContain('Sign in to OpenRows');
    expect(html).toMatch(/<a href="\/auth\/login"[^>]*>Sign in<\/a>/);
    expect(html).toMatch(/<a href="\/auth\/signup"[^>]*>Create account<\/a>/);
  });

  it('shows the signed-in shell with the user and a sign-out form', async () => {
    stubMe(ME);
    const { html } = await render('/');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@example.test');
    expect(html).toMatch(/<form[^>]*action="\/auth\/logout"[^>]*method="post"/);
  });

  it('sends signed-in visitors of /login home', async () => {
    stubMe(ME);
    const { router } = await render('/login');
    expect(router.state.location.pathname).toBe('/');
  });

  it('explains a failed sign-in and ignores unknown error codes', async () => {
    stubMe(null);
    expect((await render('/login?error=email_unverified')).html).toContain(
      'Please verify your email address first'
    );
    expect((await render('/login?error=%3Cscript%3E')).html).not.toContain('role="alert"');
  });

  // The prototype base/table routes are legacy-only until M1.
  it('does not route legacy screens', async () => {
    stubMe(ME);
    expect((await render('/bases/demo')).html).toContain('Page not found');
  });
});
