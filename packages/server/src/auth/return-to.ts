/**
 * Where to send the browser after sign-in. Only same-origin paths are accepted, so `/auth/login`
 * can't be turned into an open redirect (`//evil.example`, `/\evil.example`, `https://...`).
 */
export function safeReturnTo(value: string | undefined): string {
  if (!value || value.length > 2048) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  // Control characters (tabs, newlines) are stripped by URL parsers and can smuggle hosts.
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return '/';
  }
  try {
    const url = new URL(value, 'http://openrows.invalid');
    if (url.origin !== 'http://openrows.invalid') return '/';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/';
  }
}
