import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../router';
import { stubApi } from '../test/fakeApi';
import { ME } from '../test/me';

const NOW = '2026-10-25T10:00:00.000Z';
const KEY = 'sk-test-DOMKEY-0123456789';

function renderApp(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe('Settings → AI (#148)', () => {
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

  function seed(role = 'owner') {
    const api = stubApi(ME);
    const ws = { id: crypto.randomUUID(), name: 'Acme', role, createdAt: NOW, updatedAt: NOW };
    api.workspaces.push(ws);
    return { api, ws };
  }

  it('saves a key once, then only says one is stored, and tests the connection', async () => {
    const { api, ws } = seed();
    renderApp(`/w/${ws.id}/ai`);

    expect(await screen.findByText(/AI is off: this server has no AI provider/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openrouter' } });
    expect((screen.getByLabelText('API base URL') as HTMLInputElement).value).toBe(
      'https://openrouter.ai/api/v1'
    );
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: KEY } });
    fireEvent.click(save);

    expect(await screen.findByText("AI features use this workspace's own key.")).toBeTruthy();
    expect(api.aiSaves).toEqual([
      { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini', apiKey: KEY },
    ]);
    const key = screen.getByLabelText('API key') as HTMLInputElement;
    await waitFor(() => expect(key.value).toBe(''));
    expect(key.placeholder).toMatch(/A key is saved/);
    expect(document.body.innerHTML).not.toContain(KEY);

    // The model alone changes without the key.
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'anthropic/claude' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.aiSaves).toHaveLength(2));
    expect(api.aiSaves[1]).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude',
    });

    api.aiTest.result = {
      ok: false,
      source: 'workspace',
      model: 'anthropic/claude',
      error: 'The provider refused the API key.',
      usage: null,
      latencyMs: 40,
    };
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    const status = await screen.findByRole('status');
    await waitFor(() =>
      expect(status.textContent).toMatch(/Test failed: The provider refused the API key/)
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(await screen.findByText(/AI is off/)).toBeTruthy();
  });

  it("names the server's provider and asks again for the key on a new URL", async () => {
    const { api, ws } = seed();
    api.ai[ws.id] = {
      workspaceId: ws.id,
      source: 'workspace',
      instance: { available: true, model: 'llama3.1' },
      workspace: {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1-mini',
        hasKey: true,
        updatedAt: NOW,
      },
      allowedHosts: ['api.openai.com', 'openrouter.ai'],
    };
    renderApp(`/w/${ws.id}/ai`);
    expect(
      await screen.findByText(/This server reaches: api.openai.com, openrouter.ai/)
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openrouter' } });
    expect(screen.getByText('Enter the API key again to use it with a new URL.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(await screen.findByText(/use this server's provider \(llama3.1\)/)).toBeTruthy();
  });

  it('is for owners only', async () => {
    const { ws } = seed('creator');
    renderApp(`/w/${ws.id}/ai`);
    expect(
      await screen.findByText("Only the workspace's owners manage its AI settings.")
    ).toBeTruthy();
  });
});
