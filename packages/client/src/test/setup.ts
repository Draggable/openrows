import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom doesn't implement scrolling; TanStack Router calls it on navigation.
window.scrollTo = () => {};

// Testing Library only auto-cleans with Vitest globals enabled, and we don't enable them.
afterEach(() => {
  cleanup();
});
