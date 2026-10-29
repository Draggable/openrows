import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineBanner } from './OfflineBanner';
import { clearOfflineData, isOffline, setBrowserOnline, setNetworkAnswered } from './offline';
import { SignOutForm } from './SignOutForm';

/** Cache Storage with just names (what clearing looks at). */
function fakeCaches(names: string[]) {
  const live = new Set(names);
  return {
    live,
    storage: {
      keys: async () => [...live],
      delete: async (name: string) => live.delete(name),
    } as unknown as CacheStorage,
  };
}

afterEach(() => {
  setBrowserOnline(true);
  vi.unstubAllGlobals();
});

describe('offline data', () => {
  it("deletes every user's data and keeps the app shell", async () => {
    const { live, storage } = fakeCaches([
      'openrows-shell-abc',
      'openrows-data-0190a000-0000-7000-8000-000000000001',
      'openrows-data-0190a000-0000-7000-8000-000000000002',
      'something-else',
    ]);
    await clearOfflineData(storage);
    expect([...live]).toEqual(['openrows-shell-abc', 'something-else']);
  });

  it('signing out deletes the offline data before the form is sent', async () => {
    const { live, storage } = fakeCaches([
      'openrows-shell-abc',
      'openrows-data-0190a000-0000-7000-8000-000000000001',
    ]);
    vi.stubGlobal('caches', storage);
    const sent: string[][] = [];
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (
      this: HTMLFormElement
    ) {
      sent.push([this.method, new URL(this.action).pathname, ...live]);
    });
    render(
      <SignOutForm>
        <button type="submit">Sign out</button>
      </SignOutForm>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(sent).toEqual([['post', '/auth/logout', 'openrows-shell-abc']]);
    submit.mockRestore();
  });
});

describe('the offline banner', () => {
  it('shows while the browser or the network is offline', () => {
    render(<OfflineBanner />);
    expect(screen.queryByTestId('app-offline-banner')).toBeNull();
    act(() => setBrowserOnline(false));
    expect(screen.getByTestId('app-offline-banner').textContent).toContain('Offline, read-only.');
    act(() => setBrowserOnline(true));
    expect(screen.queryByTestId('app-offline-banner')).toBeNull();
    // The service worker answered from its cache: the server is unreachable.
    act(() => setNetworkAnswered(false));
    expect(isOffline()).toBe(true);
    expect(screen.getByTestId('app-offline-banner')).toBeTruthy();
    act(() => setNetworkAnswered(true));
    expect(screen.queryByTestId('app-offline-banner')).toBeNull();
  });
});
