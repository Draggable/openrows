import {
  type CreateOAuthAppInput,
  MAX_OAUTH_REDIRECT_URIS,
  type OAuthApp,
  type OAuthAuthorizeInfo,
  redirectUriProblem,
} from '@openrows/shared';

/** What the app form holds; redirect URIs one per line. */
export interface AppDraft {
  name: string;
  description: string;
  homepageUrl: string;
  redirectUris: string;
}

export const emptyAppDraft = (): AppDraft => ({
  name: '',
  description: '',
  homepageUrl: '',
  redirectUris: '',
});

export const draftOf = (app: OAuthApp): AppDraft => ({
  name: app.name,
  description: app.description,
  homepageUrl: app.homepageUrl ?? '',
  redirectUris: app.redirectUris.join('\n'),
});

/** The redirect URIs of the textarea: one per line, blanks and repeats dropped. */
export function redirectLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    ),
  ];
}

/** Why the draft can't be saved yet, or null when it can. */
export function appDraftProblem(d: AppDraft): string | null {
  if (!d.name.trim()) return 'Name the app.';
  const homepage = d.homepageUrl.trim();
  if (homepage && !(/^https?:\/\//i.test(homepage) && URL.canParse(homepage))) {
    return 'The homepage must be an http(s) URL.';
  }
  const uris = redirectLines(d.redirectUris);
  if (uris.length === 0) return 'Add at least one redirect URI.';
  if (uris.length > MAX_OAUTH_REDIRECT_URIS) {
    return `At most ${MAX_OAUTH_REDIRECT_URIS} redirect URIs.`;
  }
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return `${uri}: ${problem}`;
  }
  return null;
}

export function toAppRequest(d: AppDraft): CreateOAuthAppInput {
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    homepageUrl: d.homepageUrl.trim() || null,
    redirectUris: redirectLines(d.redirectUris),
  };
}

/** The authorization request's parameters, from the consent page's query string. */
export const OAUTH_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const;

export function consentQuery(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const key of OAUTH_PARAMS) {
    const v = params.get(key);
    if (v !== null) out[key] = v;
  }
  return out;
}

/** The host a redirect URI sends the browser to, as the consent screen names it. */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/** The grant draft the consent screen starts from: what the app has now, if anything. */
export function initialGrant(info: OAuthAuthorizeInfo): {
  workspaceIds: string[];
  baseIds: string[];
} {
  return {
    workspaceIds: [...(info.current?.workspaceIds ?? [])],
    baseIds: [...(info.current?.baseIds ?? [])],
  };
}

/** Where the browser goes: only to an http(s) URL (the server built it from a registered one). */
export function safeRedirect(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
