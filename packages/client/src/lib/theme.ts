import { useCallback, useSyncExternalStore } from 'react';

/**
 * Light/dark mode (DESIGN.md §3): follows `prefers-color-scheme` unless the user picked one,
 * which is kept in localStorage. `applyTheme()` sets the `.dark` class on <html>.
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_KEY = 'openrows-theme';

const listeners = new Set<() => void>();
/** A theme a page imposes without storing it (an embedded share link's `theme`). */
let override: ThemePreference | null = null;
const media = () =>
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export function getPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return media()?.matches ? 'dark' : 'light';
}

/** The browser chrome's colour per theme (`--bg-app`, the `theme-color` meta tags in index.html). */
const THEME_COLORS = { light: '#faf7f5', dark: '#17131a' } as const;

/** The preference in force: the page's override, else the user's. */
function effectivePreference(): ThemePreference {
  return override ?? getPreference();
}

export function applyTheme() {
  if (typeof document === 'undefined') return;
  const theme = resolveTheme(effectivePreference());
  document.documentElement.classList.toggle('dark', theme === 'dark');
  // A manual choice wins over the meta tags' prefers-color-scheme media queries.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLORS[theme];
  }
}

export function setPreference(pref: ThemePreference) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // Private mode: the choice lasts until reload.
  }
  applyTheme();
  for (const l of listeners) l();
}

/**
 * Imposes a theme on this page without storing it (`null` lifts it): an embedded share link
 * follows its `theme` parameter, not the visitor's OpenRows setting.
 */
export function setThemeOverride(pref: ThemePreference | null) {
  override = pref;
  applyTheme();
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const m = media();
  const onChange = () => {
    applyTheme();
    listener();
  };
  m?.addEventListener('change', onChange);
  return () => {
    listeners.delete(listener);
    m?.removeEventListener('change', onChange);
  };
}

/**
 * The store's snapshot: the preference and the theme it resolves to, so a change of the system's
 * colour scheme under `system` re-renders too.
 */
function snapshot(): `${ThemePreference}:${'light' | 'dark'}` {
  const pref = effectivePreference();
  return `${pref}:${resolveTheme(pref)}`;
}

export function useTheme() {
  const current = useSyncExternalStore(subscribe, snapshot, () => 'system:light' as const);
  const [preference, resolved] = current.split(':') as [ThemePreference, 'light' | 'dark'];
  const toggle = useCallback(
    () => setPreference(resolved === 'dark' ? 'light' : 'dark'),
    [resolved]
  );
  return { preference, resolved, setPreference, toggle };
}
