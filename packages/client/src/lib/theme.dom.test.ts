import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, useTheme } from './theme';

/** A `prefers-color-scheme: dark` query whose answer the test flips. */
function fakeMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => query)
  );
  return (dark: boolean) => {
    query.matches = dark;
    for (const l of listeners) l();
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(THEME_KEY);
  document.documentElement.classList.remove('dark');
});

describe('useTheme', () => {
  it('follows a change of the system colour scheme under "system"', () => {
    const setDark = fakeMedia(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current).toMatchObject({ preference: 'system', resolved: 'light' });
    act(() => setDark(true));
    expect(result.current).toMatchObject({ preference: 'system', resolved: 'dark' });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('keeps a stored choice over the system scheme', () => {
    const setDark = fakeMedia(false);
    localStorage.setItem(THEME_KEY, 'light');
    const { result } = renderHook(() => useTheme());
    act(() => setDark(true));
    expect(result.current).toMatchObject({ preference: 'light', resolved: 'light' });
    act(() => result.current.setPreference('dark'));
    expect(result.current.resolved).toBe('dark');
  });
});
