import {
  type MeResponse,
  PLAN_FEATURES,
  type UsageMeterValue,
  usageResetDay,
} from '@openrows/shared';
import { Link } from '@tanstack/react-router';
import { CheckIcon, MinusIcon } from 'lucide-react';
import { useWorkspace, useWorkspaceUsage } from '../api/queries';
import { Button, Skeleton } from '../components/ui';
import { isAppPath } from '../features/usage/billing-model';
import {
  aiCreditsText,
  FEATURE_LABELS,
  historyText,
  meterLevel,
  meterShare,
  meterText,
  monthName,
} from '../features/usage/model';
import { cn } from '../lib/utils';
import { HomeSidebar } from './HomeSidebar';
import { Shell, TopBar } from './Shell';

const section = 'rounded-lg border border-border bg-surface p-5 shadow-1';

/** One limit: its label, "used / limit", and a bar when there is a limit. */
function Meter({
  label,
  value,
  unit = 'count',
  resetsOn,
}: {
  label: string;
  value: UsageMeterValue;
  unit?: 'count' | 'bytes';
  /** A monthly limit's reset day. */
  resetsOn?: string;
}) {
  const level = meterLevel(value);
  const text = meterText(value, unit);
  const status = level === 'full' ? 'Limit reached' : level === 'near' ? '80% or more used' : null;
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-text-2">
          {text}
          {value.limit === null && <span className="sr-only">, no limit</span>}
        </span>
      </div>
      {value.limit !== null && (
        <>
          <meter
            aria-label={label}
            aria-valuetext={text}
            min={0}
            max={value.limit}
            value={Math.min(value.used, value.limit)}
            className="sr-only"
          />
          <div aria-hidden className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-hover">
            <div
              data-level={level}
              className={cn(
                'h-full rounded-full',
                level === 'full' ? 'bg-danger' : level === 'near' ? 'bg-warning' : 'bg-primary'
              )}
              style={{ width: `${Math.round(meterShare(value) * 100)}%` }}
            />
          </div>
          {(status || resetsOn) && (
            <p className="mt-1 flex gap-2 text-small text-text-2">
              {status && (
                <span
                  data-testid="meter-status"
                  className={cn('font-[550]', level === 'full' ? 'text-danger' : 'text-text')}
                >
                  {status}
                </span>
              )}
              {resetsOn && <span>Resets {usageResetDay(resetsOn)}</span>}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * `/w/:workspaceId/usage`: the workspace's plan, what it uses against each limit (records
 * per base, files, this month's automation runs and API calls, editors) and its features. Any
 * member can see it.: monthly limits' reset day, "80% or more used" and "Limit reached"
 * under the bars, and the owners' Upgrade button (the pricing page without billing). With
 * billing, owners get "Plan and billing" instead: the Billing page.
 */
export function UsagePage({ me, workspaceId }: { me: MeResponse; workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const usage = useWorkspaceUsage(workspaceId);
  const u = usage.data;
  const isOwner = workspace.data?.role === 'owner';
  const month = u ? monthName(u.period.start) : '';
  const unlimited =
    !!u &&
    [u.attachmentBytes, u.automationRuns, u.apiCalls, u.editors, u.aiCredits].every(
      (m) => m === null || m.limit === null
    ) &&
    u.bases.every((b) => b.limit === null);

  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <TopBar>
        <h1 className="truncate text-heading font-semibold">
          {workspace.data ? `${workspace.data.name} · Usage` : 'Usage'}
        </h1>
      </TopBar>
      <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="grid max-w-xl grid-cols-[minmax(0,1fr)] gap-6">
          {usage.isError ? (
            <p role="alert" className="text-text-2">
              Couldn't load this workspace's usage.
            </p>
          ) : !u ? (
            <Skeleton className="h-40" />
          ) : (
            <>
              <section aria-labelledby="usage-plan" className={section}>
                <div className="flex items-start justify-between gap-3">
                  <h2 id="usage-plan" className="text-heading font-semibold">
                    {u.plan.name} plan
                  </h2>
                  {u.upgradeUrl && isOwner && !isAppPath(u.upgradeUrl) && (
                    <Button size="sm" asChild>
                      <a href={u.upgradeUrl} target="_blank" rel="noopener noreferrer">
                        Upgrade
                      </a>
                    </Button>
                  )}
                  {u.upgradeUrl && isOwner && isAppPath(u.upgradeUrl) && (
                    <Button size="sm" variant="secondary" asChild>
                      <Link to="/w/$workspaceId/billing" params={{ workspaceId }}>
                        Plan and billing
                      </Link>
                    </Button>
                  )}
                </div>
                {u.upgradeUrl && !isOwner && (
                  <p className="mt-1 text-small text-text-2">
                    Workspace owners can upgrade the plan.
                  </p>
                )}
                <p className="mt-1 text-text-2">
                  {unlimited
                    ? 'No limits on records, files, automation runs or API calls.'
                    : `Automation runs, API calls${u.aiCredits ? ' and AI credits' : ''} count for ${month} (UTC) and start again next month.`}
                </p>
                <div className="mt-3">
                  <Meter label="Files" value={u.attachmentBytes} unit="bytes" />
                  <Meter
                    label={`Automation runs in ${month}`}
                    value={u.automationRuns}
                    resetsOn={u.period.end}
                  />
                  <Meter
                    label={`API calls in ${month}`}
                    value={u.apiCalls}
                    resetsOn={u.period.end}
                  />
                  {u.aiCredits && (
                    <Meter
                      label={`AI credits in ${month}`}
                      value={u.aiCredits}
                      resetsOn={u.period.end}
                    />
                  )}
                  <Meter label="Editors" value={u.editors} />
                </div>
                {u.aiCredits && (
                  <p className="mt-2 text-small text-text-2">{aiCreditsText(u.aiCredits.limit)}</p>
                )}
                <p className="mt-2 text-small text-text-2">
                  Editors are members with editor, creator or owner access to the workspace or one
                  of its bases. Record history: {historyText(u.revisionHistoryDays).toLowerCase()}.
                </p>
                <Link
                  to="/w/$workspaceId/members"
                  params={{ workspaceId }}
                  className="mt-2 inline-block text-primary underline-offset-2 hover:underline"
                >
                  See members
                </Link>
              </section>

              <section aria-labelledby="usage-records" className={section}>
                <h2 id="usage-records" className="text-heading font-semibold">
                  Records per base
                </h2>
                {u.bases.length === 0 ? (
                  <p className="mt-2 text-text-2">No bases yet.</p>
                ) : (
                  <div className="mt-2">
                    {u.bases.map((b) => (
                      <Meter
                        key={b.baseId}
                        label={b.name}
                        value={{ used: b.records, limit: b.limit }}
                      />
                    ))}
                  </div>
                )}
                <p className="mt-2 text-small text-text-2">
                  Records in the trash, and tables in the trash, don't count.
                </p>
              </section>

              <section aria-labelledby="usage-features" className={section}>
                <h2 id="usage-features" className="text-heading font-semibold">
                  Features
                </h2>
                <ul className="mt-2">
                  {PLAN_FEATURES.map((f) => (
                    <li key={f} className="flex items-center gap-2 py-1">
                      {u.features[f] ? (
                        <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" />
                      ) : (
                        <MinusIcon aria-hidden className="size-4 shrink-0 text-text-2" />
                      )}
                      <span className={cn('min-w-0', !u.features[f] && 'text-text-2')}>
                        {FEATURE_LABELS[f]}
                      </span>
                      <span className="sr-only">
                        {u.features[f] ? ', included' : ', not included'}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>
      </main>
    </Shell>
  );
}
