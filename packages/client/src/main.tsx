import './lib/zod';
import { QueryClient } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startOfflineSupport } from './features/offline/offline';
import { applyTheme } from './lib/theme';
import { createAppRouter } from './router';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1 minute
      retry: 1,
      // Offline, a query still runs once: the service worker answers from its cache.
      networkMode: 'offlineFirst',
    },
  },
});

applyTheme();
// The service worker only in production builds: `vite dev` serves no /sw.js.
startOfflineSupport({ register: import.meta.env.PROD });

const router = createAppRouter({ queryClient });

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element in index.html');

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
