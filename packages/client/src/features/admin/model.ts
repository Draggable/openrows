import type { AdminAuditAction, AdminSetPlan } from '@openrows/shared';
import { planOverridesSchema } from '@openrows/shared';
import { ApiError } from '../../api/client';

/** The ops console's path. */
export const ADMIN_PATH = '/admin';

/** The provider asks for the password again, then sends the browser back to the console. */
export function adminReauthHref(): string {
  const params = new URLSearchParams({ reauth: '1', returnTo: ADMIN_PATH });
  return `/auth/login?${params.toString()}`;
}

/**
 * What a console request's failure means: `unavailable` (404: not a system admin, or the OSS
 * edition, which has no console), `reauth` (a sign-in in the last 30 minutes is needed) or
 * anything else.
 */
export function consoleState(error: unknown): 'unavailable' | 'reauth' | 'error' {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'unavailable';
    if (error.code === 'REAUTHENTICATION_REQUIRED') return 'reauth';
  }
  return 'error';
}

/** The plan form's draft: the plan id ('' for the default) and the overrides as JSON text. */
export interface PlanDraft {
  plan: string;
  overrides: string;
}

/** The request of a plan draft, or the problem with it. */
export function planRequest(draft: PlanDraft): { body: AdminSetPlan } | { problem: string } {
  let overrides: unknown;
  try {
    overrides = draft.overrides.trim() === '' ? {} : JSON.parse(draft.overrides);
  } catch {
    return { problem: 'Overrides must be JSON.' };
  }
  const parsed = planOverridesSchema.safeParse(overrides);
  if (!parsed.success) return { problem: 'Overrides take `limits` and `features` only.' };
  const plan = draft.plan.trim();
  return { body: { plan: plan === '' ? null : plan, overrides: parsed.data } };
}

const ACTION_LABELS: Record<AdminAuditAction, string> = {
  'workspaces.list': 'Listed workspaces',
  'workspace.view': 'Viewed workspace',
  'workspace.plan': 'Set plan',
  'workspace.suspend': 'Suspended workspace',
  'workspace.unsuspend': 'Lifted workspace suspension',
  'webhook.revoke': 'Deleted webhook',
  'users.list': 'Listed users',
  'user.view': 'Viewed user',
  'user.suspend': 'Suspended user',
  'user.unsuspend': 'Lifted user suspension',
  'token.revoke': 'Revoked token',
  'impersonation.start': 'Started impersonation',
  'impersonation.end': 'Ended impersonation',
  'audit.list': 'Read audit log',
};

export function actionLabel(action: AdminAuditAction): string {
  return ACTION_LABELS[action];
}

/** A date and time for the console's tables, or a dash. */
export function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Whole minutes left until `iso` (never below 0). */
export function minutesLeft(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 60_000));
}
