import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from './router';
import { stubMe } from './test/me';

describe('router in the DOM', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the requested path through sign-in', async () => {
    stubMe(null);
    const router = createAppRouter({
      history: createMemoryHistory({ initialEntries: ['/?view=1'] }),
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    });
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('heading', { name: 'Sign in to OpenRows' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe(
      '/auth/login?returnTo=%2F%3Fview%3D1'
    );
  });
});
