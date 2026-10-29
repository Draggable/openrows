import type { MeResponse } from '@openrows/shared';
import { queryOptions } from '@tanstack/react-query';
import { ApiError, api, fetchAuthJson } from '../api/client';
import { queryKeys } from '../api/keys';

/**
 * The signed-in user, or null. Sign-in itself is a full-page redirect through the server
 * (`/auth/login`, ADR-006); the browser never sees a token, only the session cookie.
 */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api.me.get();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export const meQuery = queryOptions({
  queryKey: queryKeys.me(),
  queryFn: fetchMe,
  staleTime: 60_000,
});

/**
 * Where the sign-in and sign-up buttons go. The server redirects to the provider; with
 * `provider` (an identity-provider alias such as `github`) straight to that one.
 */
export function loginHref(
  kind: 'login' | 'signup',
  returnTo?: string,
  provider?: string,
  /** "Sign in with SSO": the server finds the address's identity provider. */
  email?: string
): string {
  const path = kind === 'signup' ? '/auth/signup' : '/auth/login';
  const params = new URLSearchParams();
  if (provider) params.set('provider', provider);
  if (email) params.set('email', email);
  if (returnTo && returnTo !== '/') params.set('returnTo', returnTo);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** What the sign-in page shows, from the server's public `GET /auth/providers`. */
export interface SignInInfo {
  /** The social sign-in providers (AUTH_PROVIDERS), e.g. `['github']`. */
  providers: string[];
  /** The instance's public status page (STATUS_PAGE_URL), or null: no link. */
  statusPageUrl: string | null;
}

/** Only an http(s) URL becomes a link (never `javascript:` and the like, whatever the server says). */
function linkUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export async function fetchSignInInfo(): Promise<SignInInfo> {
  const body = (await fetchAuthJson('/auth/providers')) as
    | { providers?: unknown; statusPageUrl?: unknown }
    | undefined;
  const providers = Array.isArray(body?.providers)
    ? body.providers.filter((p): p is string => typeof p === 'string')
    : [];
  return { providers, statusPageUrl: linkUrl(body?.statusPageUrl) };
}

export const signInInfoQuery = queryOptions({
  queryKey: ['auth', 'providers'] as const,
  queryFn: fetchSignInInfo,
  staleTime: Number.POSITIVE_INFINITY,
  retry: false,
});
