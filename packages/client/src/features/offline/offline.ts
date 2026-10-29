import { useSyncExternalStore } from 'react';
import { isDataCache, NETWORK_MESSAGE } from '../../sw/policy';

/**
 * The app's offline state: the browser says it's offline, or the service worker just
 * answered an API request from its cache because the network failed. While offline the app is
 * read-only and shows a banner.
 */
let browserOnline = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
let networkAnswered = true;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function isOffline(): boolean {
  return !browserOnline || !networkAnswered;
}

/** Sets what the browser reports (the `online`/`offline` events). */
export function setBrowserOnline(online: boolean): void {
  browserOnline = online;
  // Back online: trust the network again until a request says otherwise.
  if (online) networkAnswered = true;
  emit();
}

/** Sets whether the network answered the last API request (the service worker's message). */
export function setNetworkAnswered(answered: boolean): void {
  if (networkAnswered === answered) return;
  networkAnswered = answered;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether the app is offline, kept current. */
export function useOffline(): boolean {
  return useSyncExternalStore(subscribe, isOffline, () => false);
}

/**
 * Deletes every user's offline data (the service worker's `openrows-data-*` caches); the app
 * shell stays. Called before signing out, so the next person on this browser sees nothing.
 */
export async function clearOfflineData(
  storage: CacheStorage | undefined = typeof caches === 'undefined' ? undefined : caches
): Promise<void> {
  if (!storage) return;
  const names = await storage.keys();
  await Promise.all(names.filter(isDataCache).map((name) => storage.delete(name)));
}

/**
 * Registers /sw.js (built by vite/service-worker.ts, production builds only) and follows the
 * browser's and the worker's view of the network.
 */
export function startOfflineSupport({ register }: { register: boolean }): void {
  window.addEventListener('online', () => setBrowserOnline(true));
  window.addEventListener('offline', () => setBrowserOnline(false));
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; ok?: unknown } | null;
    if (data?.type === NETWORK_MESSAGE && typeof data.ok === 'boolean') {
      setNetworkAnswered(data.ok);
    }
  });
  if (!register) return;
  const start = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // No worker (private mode, an old browser): the app works online as before.
    });
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
