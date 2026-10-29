import {
  type AccessToken,
  type CreateAccessTokenInput,
  DEFAULT_TOKEN_TTL_DAYS,
  MAX_TOKEN_TTL_DAYS,
  TOKEN_SCOPES,
  type TokenScope,
} from '@openrows/shared';

/** The expiry choices of the token form, in days. */
export const EXPIRY_OPTIONS: { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: DEFAULT_TOKEN_TTL_DAYS, label: `${DEFAULT_TOKEN_TTL_DAYS} days` },
  { days: 180, label: '180 days' },
  { days: MAX_TOKEN_TTL_DAYS, label: '1 year' },
];

/** The scopes in the form's order: records, comments, schema, then the rest. */
export const SCOPE_ORDER: readonly TokenScope[] = TOKEN_SCOPES;

/** What the form holds: chosen scopes, whole workspaces, and single bases. */
export interface TokenDraft {
  name: string;
  scopes: TokenScope[];
  workspaceIds: string[];
  baseIds: string[];
  expiresInDays: number;
}

export const emptyDraft = (): TokenDraft => ({
  name: '',
  scopes: [],
  workspaceIds: [],
  baseIds: [],
  expiresInDays: DEFAULT_TOKEN_TTL_DAYS,
});

/** Why the draft can't be created yet, or null when it can. */
export function draftProblem(d: TokenDraft): string | null {
  if (!d.name.trim()) return 'Name the token.';
  if (d.scopes.length === 0) return 'Pick at least one scope.';
  if (d.workspaceIds.length + d.baseIds.length === 0) {
    return 'Give it access to at least one workspace or base.';
  }
  return null;
}

/**
 * The create request. A base inside a whole granted workspace is already covered, so `baseIds`
 * only keeps bases of other workspaces (`baseWorkspace` maps a base to its workspace).
 */
export function toRequest(
  d: TokenDraft,
  baseWorkspace: ReadonlyMap<string, string>
): CreateAccessTokenInput {
  return {
    name: d.name.trim(),
    scopes: SCOPE_ORDER.filter((s) => d.scopes.includes(s)),
    workspaceIds: d.workspaceIds,
    baseIds: d.baseIds.filter((b) => !d.workspaceIds.includes(baseWorkspace.get(b) ?? '')),
    expiresInDays: d.expiresInDays,
  };
}

/** Adds or removes `value`. */
export function toggle<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on
    ? list.includes(value)
      ? [...list]
      : [...list, value]
    : list.filter((v) => v !== value);
}

export function isExpired(t: Pick<AccessToken, 'expiresAt'>, now = Date.now()): boolean {
  return Date.parse(t.expiresAt) <= now;
}

/** "3 workspaces, 1 base" */
export function grantSummary(t: Pick<AccessToken, 'workspaceIds' | 'baseIds'>): string {
  const parts: string[] = [];
  const w = t.workspaceIds.length;
  const b = t.baseIds.length;
  if (w) parts.push(`${w} workspace${w === 1 ? '' : 's'}`);
  if (b) parts.push(`${b} base${b === 1 ? '' : 's'}`);
  return parts.join(', ') || 'Nothing';
}

/** Requests made with a token today (UTC, the last day of `usage`) and over its 7 days. */
export function usageTotals(t: Pick<AccessToken, 'usage'>): { today: number; week: number } {
  return {
    today: t.usage.at(-1)?.requests ?? 0,
    week: t.usage.reduce((n, d) => n + d.requests, 0),
  };
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** "12 requests today · 340 in 7 days" */
export function usageSummary(t: Pick<AccessToken, 'usage'>): string {
  const { today, week } = usageTotals(t);
  return `${plural(today, 'request')} today · ${week.toLocaleString()} in ${t.usage.length} days`;
}
