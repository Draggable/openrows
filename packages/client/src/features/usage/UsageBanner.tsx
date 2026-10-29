import {
  type Base,
  type UsageWarning,
  type UserRole,
  usageWarnings,
  usageWarningText,
} from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { GaugeIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useBaseUsageWarnings, useWorkspaces, workspaceQueries } from '../../api/queries';
import { Button } from '../../components/ui';
import { cn } from '../../lib/utils';
import { isAppPath } from './billing-model';
import { bannerDismissed, bannerSignature, dismissBanner, seesUsageWarnings } from './model';

/** Warnings shown at once; the Usage page has the rest. */
const SHOWN = 3;

/**
 * The plan-limit banner at the top of a workspace or a base, for owners and creators:
 * each limit at 80% (amber) or 100% (red) as `usageWarningText` says it, "See usage" (workspace
 * members) and "Upgrade" (owners, where the edition has somewhere to upgrade). Ledger: a neutral
 * fill with a 2 px top accent, never a coloured left border. Dismissed until a warning is new,
 * goes up a level, or a month passes.
 */
export function UsageBanner({
  scope,
  warnings,
  workspaceId,
  showUsageLink,
  upgradeUrl,
}: {
  /** What dismissing remembers it by: the workspace or the base. */
  scope: string;
  warnings: readonly UsageWarning[];
  workspaceId: string;
  showUsageLink: boolean;
  /** The owners' upgrade link; null hides the button. */
  upgradeUrl: string | null;
}) {
  const signature = bannerSignature(warnings);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (warnings.length === 0 || dismissed === signature || bannerDismissed(scope, signature)) {
    return null;
  }
  const full = warnings.some((w) => w.level === 'full');
  const more = warnings.length - SHOWN;
  return (
    <div
      role="status"
      data-testid="usage-banner"
      data-level={full ? 'full' : 'near'}
      className={cn(
        'flex shrink-0 items-start gap-2 border-b border-border border-t-2 bg-header px-3 py-2 md:px-6',
        full ? 'border-t-danger' : 'border-t-warning'
      )}
    >
      <GaugeIcon
        aria-hidden
        className={cn('mt-0.5 size-4 shrink-0', full ? 'text-danger' : 'text-[var(--warning)]')}
      />
      <div className="min-w-0 flex-1">
        <p className="font-[550]">{full ? 'A plan limit is reached' : 'Close to a plan limit'}</p>
        <ul className="text-text-2">
          {warnings.slice(0, SHOWN).map((w) => (
            <li key={`${w.metric}:${w.base?.id ?? ''}`}>{usageWarningText(w)}</li>
          ))}
          {more > 0 && <li>And {more} more on the Usage page.</li>}
        </ul>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {showUsageLink && (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/w/$workspaceId/usage" params={{ workspaceId }}>
              See usage
            </Link>
          </Button>
        )}
        {upgradeUrl && (
          <Button size="sm" asChild>
            {isAppPath(upgradeUrl) ? (
              <a href={upgradeUrl}>Upgrade</a>
            ) : (
              <a href={upgradeUrl} target="_blank" rel="noopener noreferrer">
                Upgrade
              </a>
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss"
          onClick={() => {
            dismissBanner(scope, signature);
            setDismissed(signature);
          }}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

/** The banner on a base's pages, from the base's warnings (base-only creators too). */
export function BaseUsageBanner({ base }: { base: Base | undefined }) {
  const allowed = !!base && seesUsageWarnings(base.role);
  const warnings = useBaseUsageWarnings(base?.id ?? '', allowed);
  const workspaces = useWorkspaces();
  if (!base || !allowed || !warnings.data) return null;
  // Base-only collaborators have no workspace role: no Usage page for them.
  const workspaceRole =
    workspaces.data?.workspaces.find((w) => w.id === base.workspaceId)?.role ?? null;
  return (
    <UsageBanner
      scope={`base:${base.id}`}
      warnings={warnings.data.warnings}
      workspaceId={base.workspaceId}
      showUsageLink={workspaceRole !== null}
      upgradeUrl={workspaceRole === 'owner' ? warnings.data.upgradeUrl : null}
    />
  );
}

/** The banner on a workspace's home, from its usage, for its owners and creators. */
export function WorkspaceUsageBanner({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: UserRole | null;
}) {
  const allowed = seesUsageWarnings(role);
  const usage = useQuery({ ...workspaceQueries.usage(workspaceId), enabled: allowed });
  const warnings = useMemo(() => (usage.data ? usageWarnings(usage.data) : []), [usage.data]);
  if (!allowed || !usage.data) return null;
  return (
    <UsageBanner
      scope={`workspace:${workspaceId}`}
      warnings={warnings}
      workspaceId={workspaceId}
      showUsageLink
      upgradeUrl={role === 'owner' ? usage.data.upgradeUrl : null}
    />
  );
}
