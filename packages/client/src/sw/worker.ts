/// <reference lib="webworker" />
// The service worker, built to /sw.js by vite/service-worker.ts (which defines the two
// constants below). Its behaviour is in handlers.ts; this only wires it to the global scope.
import { createWorker } from './handlers';
import { NETWORK_MESSAGE } from './policy';

declare const __OPENROWS_PRECACHE__: string[];
declare const __OPENROWS_BUILD__: string;

const sw = self as unknown as ServiceWorkerGlobalScope;

const worker = createWorker({
  caches: sw.caches,
  fetch: (request) => fetch(request),
  origin: sw.location.origin,
  precache: __OPENROWS_PRECACHE__,
  build: __OPENROWS_BUILD__,
  notify: (clientId, networkAnswered) => {
    if (!clientId) return;
    void sw.clients.get(clientId).then((client) => {
      client?.postMessage({ type: NETWORK_MESSAGE, ok: networkAnswered });
    });
  },
});

sw.addEventListener('install', (event) => {
  event.waitUntil(worker.install().then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(worker.activate().then(() => sw.clients.claim()));
});

sw.addEventListener('fetch', (event) => {
  const handled = worker.handle(event.request, event.clientId);
  if (!handled) return;
  event.respondWith(handled.response);
  if (handled.after) event.waitUntil(handled.after);
});
