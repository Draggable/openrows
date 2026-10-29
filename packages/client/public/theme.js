// Applies dark mode before the first paint; src/lib/theme.ts keeps it in sync afterwards.
// An embedded share link follows its `theme` parameter (light, dark or auto) instead.
try {
  const embedded = location.pathname.startsWith('/embed/');
  const param = embedded ? new URLSearchParams(location.search).get('theme') : null;
  const embed = param === 'dark' || param === 'auto' ? param : 'light';
  const t = !embedded ? localStorage.getItem('openrows-theme') : embed === 'auto' ? null : embed;
  if (t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
} catch {
  // No storage access: follow the light default until the app loads.
}
