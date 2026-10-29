import type {
  AdminToken,
  AdminUserSummary,
  AdminWorkspaceSummary,
  MeResponse,
} from '@openrows/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { ApiError, adminApi } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { HomeSidebar } from '../../app/HomeSidebar';
import { Shell, TopBar } from '../../app/Shell';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  toast,
} from '../../components/ui';
import { cn } from '../../lib/utils';
import {
  actionLabel,
  adminReauthHref,
  consoleState,
  type PlanDraft,
  planRequest,
  when,
} from './model';

type Tab = 'workspaces' | 'users' | 'audit';
const TABS: { id: Tab; label: string }[] = [
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit log' },
];
const PAGE = 50;

/** No retries when the console isn't there or wants a fresh sign-in: those won't change. */
const retry = (count: number, error: unknown) => consoleState(error) === 'error' && count < 2;

const card = 'rounded-lg border border-border bg-surface shadow-1';
const th = 'h-8 border-b border-border px-3 text-left text-small font-[550] text-text-2';
const td = 'h-[34px] border-b border-border px-3';

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong.';
}

/** The console's answer when it can't be used: no console here, or sign in again. */
function ConsoleBlocked({ error }: { error: unknown }) {
  const state = consoleState(error);
  return (
    <div className={cn(card, 'max-w-lg p-5')} data-testid="admin-blocked">
      {state === 'reauth' ? (
        <>
          <h2 className="text-heading font-semibold">Sign in again</h2>
          <p className="mt-1 text-text-2">
            The ops console needs a sign-in within the last 30 minutes.
          </p>
          <Button className="mt-4" onClick={() => window.location.assign(adminReauthHref())}>
            Sign in again
          </Button>
        </>
      ) : state === 'unavailable' ? (
        <>
          <h2 className="text-heading font-semibold">No ops console here</h2>
          <p className="mt-1 text-text-2">
            The ops console is part of the hosted edition and open to system admins only.
          </p>
        </>
      ) : (
        <p className="text-danger">{errorText(error)}</p>
      )}
    </div>
  );
}

/** Asks for a reason, then runs `onConfirm` with it (suspending, impersonating). */
function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirm: string;
  destructive?: boolean;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await onConfirm(reason.trim());
      onOpenChange(false);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <label htmlFor={id} className="mt-3 block font-[550]">
            Reason
          </label>
          <Input
            id={id}
            className="mt-1"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ticket or report reference"
            autoFocus
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={destructive ? 'destructive' : 'default'}
              disabled={busy || !reason.trim()}
            >
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Search({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <Input
      type="search"
      aria-label={label}
      placeholder={label}
      className="max-w-xs"
      value={value}
      maxLength={200}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Pager({
  offset,
  total,
  onChange,
}: {
  offset: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= PAGE) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-small text-text-2">
      <span className="tabular-nums">
        {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
      </span>
      <Button
        size="sm"
        variant="ghost"
        disabled={offset === 0}
        onClick={() => onChange(offset - PAGE)}
      >
        Previous
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={offset + PAGE >= total}
        onClick={() => onChange(offset + PAGE)}
      >
        Next
      </Button>
    </div>
  );
}

function Status({
  suspendedAt,
  deletedAt,
}: {
  suspendedAt: string | null;
  deletedAt: string | null;
}) {
  if (deletedAt) return <span className="text-text-2">Deleted</span>;
  if (suspendedAt) return <span className="font-[550] text-danger">Suspended</span>;
  return <span className="text-text-2">Active</span>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border px-4 py-3">
      <h3 className="font-[550]">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function TokenList({
  tokens,
  onRevoke,
}: {
  tokens: AdminToken[];
  onRevoke: (t: AdminToken) => void;
}) {
  if (tokens.length === 0) return <p className="text-text-2">None.</p>;
  return (
    <ul className="grid gap-1">
      {tokens.map((t) => (
        <li key={t.id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {t.name}
            <span className="text-small text-text-2">
              {' '}
              · {t.userEmail ?? t.userId} · used {when(t.lastUsedAt)}
            </span>
          </span>
          {t.revokedAt ? (
            <span className="text-small text-text-2">Revoked</span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onRevoke(t)}>
              Revoke
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.all() });
}

function PlanForm({
  workspaceId,
  plan,
  overrides,
}: {
  workspaceId: string;
  plan: string | null;
  overrides: object;
}) {
  const [draft, setDraft] = useState<PlanDraft>({
    plan: plan ?? '',
    overrides: Object.keys(overrides).length ? JSON.stringify(overrides) : '',
  });
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: (body: ReturnType<typeof planRequest>) => {
      if ('problem' in body) throw new Error(body.problem);
      return adminApi.workspaces.setPlan({ params: { workspaceId }, body: body.body });
    },
    onSuccess: () => {
      toast.success('Plan saved');
      void invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : errorText(err)),
  });
  const planId = useId();
  const overridesId = useId();
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(planRequest(draft));
      }}
    >
      <label htmlFor={planId} className="text-small text-text-2">
        Plan id (empty: the default plan)
      </label>
      <Input
        id={planId}
        value={draft.plan}
        onChange={(e) => setDraft({ ...draft, plan: e.target.value })}
      />
      <label htmlFor={overridesId} className="text-small text-text-2">
        Overrides (JSON: limits, features)
      </label>
      <textarea
        id={overridesId}
        rows={3}
        className="rounded-sm border border-border bg-surface px-2 py-1 font-mono text-small"
        value={draft.overrides}
        onChange={(e) => setDraft({ ...draft, overrides: e.target.value })}
      />
      <Button type="submit" size="sm" className="w-fit" disabled={save.isPending}>
        Save plan
      </Button>
    </form>
  );
}

function WorkspaceDetail({ workspaceId }: { workspaceId: string }) {
  const detail = useQuery({
    queryKey: queryKeys.admin.workspace(workspaceId),
    retry,
    queryFn: () => adminApi.workspaces.get({ params: { workspaceId } }),
  });
  const invalidate = useInvalidate();
  const [suspendOpen, setSuspendOpen] = useState(false);
  const done = (message: string) => () => {
    toast.success(message);
    void invalidate();
  };
  const fail = (err: unknown) => toast.error(errorText(err));

  if (detail.isPending) return <Skeleton className="h-40 w-full" />;
  if (detail.isError) return <p className="p-4 text-danger">{errorText(detail.error)}</p>;
  const { workspace, usage, members, tokens, webhooks } = detail.data;
  const records = usage.bases.reduce((n, b) => n + b.records, 0);

  return (
    <div data-testid="admin-workspace-detail">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-heading font-semibold">{workspace.name}</h2>
          <p className="text-small text-text-2 [overflow-wrap:anywhere]">{workspace.id}</p>
          <p className="mt-1">
            <Status suspendedAt={workspace.suspendedAt} deletedAt={workspace.deletedAt} />
            {workspace.suspendedReason && (
              <span className="text-text-2"> · {workspace.suspendedReason}</span>
            )}
          </p>
        </div>
        {workspace.suspendedAt ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              adminApi.workspaces
                .setSuspension({ params: { workspaceId }, body: { suspended: false } })
                .then(done('Suspension lifted'), fail)
            }
          >
            Lift suspension
          </Button>
        ) : (
          <Button size="sm" variant="destructive" onClick={() => setSuspendOpen(true)}>
            Suspend
          </Button>
        )}
      </div>
      <Section title="Plan and usage">
        <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-1 tabular-nums">
          <dt className="text-text-2">Plan</dt>
          <dd>{usage.plan.name}</dd>
          <dt className="text-text-2">Records</dt>
          <dd>{records.toLocaleString()}</dd>
          <dt className="text-text-2">Editors</dt>
          <dd>{usage.editors.used}</dd>
          <dt className="text-text-2">API calls (month)</dt>
          <dd>{usage.apiCalls.used.toLocaleString()}</dd>
          <dt className="text-text-2">Automation runs</dt>
          <dd>{usage.automationRuns.used.toLocaleString()}</dd>
          <dt className="text-text-2">Created</dt>
          <dd>{when(workspace.createdAt)}</dd>
          <dt className="text-text-2">Last active</dt>
          <dd>{when(workspace.lastActiveAt)}</dd>
        </dl>
        <div className="mt-3">
          <PlanForm
            key={`${workspace.plan}:${JSON.stringify(workspace.planOverrides)}`}
            workspaceId={workspaceId}
            plan={workspace.plan}
            overrides={workspace.planOverrides}
          />
        </div>
      </Section>
      <Section title={`Members (${members.length})`}>
        <ul className="grid gap-1">
          {members.map((m) => (
            <li key={m.userId} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate">{m.email ?? m.name ?? m.userId}</span>
              <span className="text-text-2">{m.role}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Personal access tokens">
        <TokenList
          tokens={tokens}
          onRevoke={(t) =>
            adminApi.users
              .revokeToken({ params: { userId: t.userId, tokenId: t.id } })
              .then(done('Token revoked'), fail)
          }
        />
      </Section>
      <Section title="Webhooks">
        {webhooks.length === 0 ? (
          <p className="text-text-2">None.</p>
        ) : (
          <ul className="grid gap-1">
            {webhooks.map((w) => (
              <li key={w.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {w.host}
                  <span className="text-small text-text-2">
                    {' '}
                    · {w.baseName} · {w.enabled ? 'on' : 'off'}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    adminApi.workspaces
                      .revokeWebhook({ params: { workspaceId, webhookId: w.id } })
                      .then(done('Webhook deleted'), fail)
                  }
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <ReasonDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        title={`Suspend ${workspace.name}?`}
        description="Members can still read everything; nothing can change, and its share links and forms stop working until you lift it."
        confirm="Suspend workspace"
        destructive
        onConfirm={(reason) =>
          adminApi.workspaces
            .setSuspension({ params: { workspaceId }, body: { suspended: true, reason } })
            .then(done('Workspace suspended'))
        }
      />
    </div>
  );
}

function UserDetail({ userId }: { userId: string }) {
  const detail = useQuery({
    queryKey: queryKeys.admin.user(userId),
    retry,
    queryFn: () => adminApi.users.get({ params: { userId } }),
  });
  const invalidate = useInvalidate();
  const [dialog, setDialog] = useState<'suspend' | 'impersonate' | null>(null);
  const done = (message: string) => () => {
    toast.success(message);
    void invalidate();
  };
  const fail = (err: unknown) => toast.error(errorText(err));

  if (detail.isPending) return <Skeleton className="h-40 w-full" />;
  if (detail.isError) return <p className="p-4 text-danger">{errorText(detail.error)}</p>;
  const { user, memberships, tokens } = detail.data;
  const label = user.email ?? user.name ?? user.id;

  return (
    <div data-testid="admin-user-detail">
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-heading font-semibold">{label}</h2>
          <p className="text-small text-text-2 [overflow-wrap:anywhere]">{user.id}</p>
          <p className="mt-1">
            {user.isSystemAdmin && <span className="font-[550]">System admin · </span>}
            <Status suspendedAt={user.suspendedAt} deletedAt={user.deletedAt} />
            {user.suspendedReason && <span className="text-text-2"> · {user.suspendedReason}</span>}
          </p>
        </div>
        {!user.isSystemAdmin && !user.deletedAt && (
          <div className="flex gap-2">
            {!user.suspendedAt && (
              <Button size="sm" variant="secondary" onClick={() => setDialog('impersonate')}>
                Impersonate
              </Button>
            )}
            {user.suspendedAt ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  adminApi.users
                    .setSuspension({ params: { userId }, body: { suspended: false } })
                    .then(done('Suspension lifted'), fail)
                }
              >
                Lift suspension
              </Button>
            ) : (
              <Button size="sm" variant="destructive" onClick={() => setDialog('suspend')}>
                Suspend
              </Button>
            )}
          </div>
        )}
      </div>
      <Section title="Account">
        <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-1 tabular-nums">
          <dt className="text-text-2">Created</dt>
          <dd>{when(user.createdAt)}</dd>
          <dt className="text-text-2">Last active</dt>
          <dd>{when(user.lastActiveAt)}</dd>
        </dl>
      </Section>
      <Section title={`Workspaces (${memberships.length})`}>
        <ul className="grid gap-1">
          {memberships.map((m) => (
            <li key={m.workspaceId} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate">{m.workspaceName}</span>
              <span className="text-text-2">{m.role}</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Personal access tokens">
        <TokenList
          tokens={tokens}
          onRevoke={(t) =>
            adminApi.users
              .revokeToken({ params: { userId, tokenId: t.id } })
              .then(done('Token revoked'), fail)
          }
        />
      </Section>
      <ReasonDialog
        open={dialog === 'suspend'}
        onOpenChange={(open) => setDialog(open ? 'suspend' : null)}
        title={`Suspend ${label}?`}
        description="They are signed out everywhere; signing in and their personal access tokens are refused until you lift it."
        confirm="Suspend user"
        destructive
        onConfirm={(reason) =>
          adminApi.users
            .setSuspension({ params: { userId }, body: { suspended: true, reason } })
            .then(done('User suspended'))
        }
      />
      <ReasonDialog
        open={dialog === 'impersonate'}
        onOpenChange={(open) => setDialog(open ? 'impersonate' : null)}
        title={`View the app as ${label}?`}
        description="Read-only, for 15 minutes. They see it in their account settings, and it's in the audit log."
        confirm="Impersonate"
        onConfirm={async (reason) => {
          await adminApi.users.impersonate({ params: { userId }, body: { reason } });
          window.location.assign('/');
        }}
      />
    </div>
  );
}

function WorkspacesTab({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const list = useQuery({
    queryKey: queryKeys.admin.workspaces(q, offset),
    retry,
    queryFn: () => adminApi.workspaces.list({ query: { q: q || undefined, limit: PAGE, offset } }),
    placeholderData: (prev) => prev,
  });
  return (
    <ListLayout
      search={
        <Search
          label="Search workspaces"
          value={q}
          onChange={(v) => {
            setQ(v);
            setOffset(0);
          }}
        />
      }
      error={list.error}
      pending={list.isPending}
      pager={<Pager offset={offset} total={list.data?.total ?? 0} onChange={setOffset} />}
    >
      <table className="w-full tabular-nums">
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Plan</th>
            <th className={cn(th, 'text-right')}>Members</th>
            <th className={cn(th, 'text-right')}>Records</th>
            <th className={th}>Last active</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {(list.data?.workspaces ?? []).map((w: AdminWorkspaceSummary) => (
            <tr key={w.id} className={cn('hover:bg-hover', selected === w.id && 'bg-selected')}>
              <td className={td}>
                <button
                  type="button"
                  className="text-left font-[550] hover:underline"
                  onClick={() => onSelect(w.id)}
                >
                  {w.name}
                </button>
              </td>
              <td className={td}>{w.plan ?? 'default'}</td>
              <td className={cn(td, 'text-right')}>{w.members}</td>
              <td className={cn(td, 'text-right')}>{w.records.toLocaleString()}</td>
              <td className={td}>{when(w.lastActiveAt)}</td>
              <td className={td}>
                <Status suspendedAt={w.suspendedAt} deletedAt={w.deletedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListLayout>
  );
}

function UsersTab({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const list = useQuery({
    queryKey: queryKeys.admin.users(q, offset),
    retry,
    queryFn: () => adminApi.users.list({ query: { q: q || undefined, limit: PAGE, offset } }),
    placeholderData: (prev) => prev,
  });
  return (
    <ListLayout
      search={
        <Search
          label="Search users"
          value={q}
          onChange={(v) => {
            setQ(v);
            setOffset(0);
          }}
        />
      }
      error={list.error}
      pending={list.isPending}
      pager={<Pager offset={offset} total={list.data?.total ?? 0} onChange={setOffset} />}
    >
      <table className="w-full tabular-nums">
        <thead>
          <tr>
            <th className={th}>Email</th>
            <th className={th}>Name</th>
            <th className={cn(th, 'text-right')}>Workspaces</th>
            <th className={th}>Last active</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {(list.data?.users ?? []).map((u: AdminUserSummary) => (
            <tr key={u.id} className={cn('hover:bg-hover', selected === u.id && 'bg-selected')}>
              <td className={td}>
                <button
                  type="button"
                  className="text-left font-[550] hover:underline"
                  onClick={() => onSelect(u.id)}
                >
                  {u.email ?? u.id}
                </button>
              </td>
              <td className={td}>{u.name ?? '—'}</td>
              <td className={cn(td, 'text-right')}>{u.workspaces}</td>
              <td className={td}>{when(u.lastActiveAt)}</td>
              <td className={td}>
                <Status suspendedAt={u.suspendedAt} deletedAt={u.deletedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListLayout>
  );
}

function AuditTab() {
  const [before, setBefore] = useState<string | null>(null);
  const list = useQuery({
    queryKey: queryKeys.admin.audit(before),
    retry,
    queryFn: () => adminApi.audit.list({ query: { limit: PAGE, before: before ?? undefined } }),
  });
  return (
    <ListLayout
      error={list.error}
      pending={list.isPending}
      pager={
        <div className="flex gap-2 px-3 py-2">
          {before && (
            <Button size="sm" variant="ghost" onClick={() => setBefore(null)}>
              Newest
            </Button>
          )}
          {list.data?.nextBefore && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setBefore(list.data?.nextBefore ?? null)}
            >
              Older
            </Button>
          )}
        </div>
      }
    >
      <table className="w-full tabular-nums" data-testid="admin-audit">
        <thead>
          <tr>
            <th className={th}>When</th>
            <th className={th}>Admin</th>
            <th className={th}>Action</th>
            <th className={th}>Target</th>
          </tr>
        </thead>
        <tbody>
          {(list.data?.entries ?? []).map((e) => (
            <tr key={e.id}>
              <td className={td}>{when(e.createdAt)}</td>
              <td className={td}>{e.adminEmail ?? e.adminId}</td>
              <td className={td}>{actionLabel(e.action)}</td>
              <td className={cn(td, 'text-small text-text-2')}>
                {e.targetWorkspaceId ?? e.targetUserId ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ListLayout>
  );
}

function ListLayout({
  search,
  error,
  pending,
  pager,
  children,
}: {
  search?: ReactNode;
  error: unknown;
  pending: boolean;
  pager: ReactNode;
  children: ReactNode;
}) {
  if (error) return <ConsoleBlocked error={error} />;
  return (
    <div className={cn(card, 'min-w-0 overflow-hidden')}>
      {search && <div className="border-b border-border p-3">{search}</div>}
      <div className="overflow-x-auto">
        {pending ? <Skeleton className="m-3 h-24" /> : children}
      </div>
      {pager}
    </div>
  );
}

/**
 * `/admin`: the hosted ops console, for system admins with a recent sign-in. Workspaces
 * (plan, usage, members, tokens, webhooks; plan overrides, suspension), users (memberships,
 * tokens; suspension, read-only impersonation) and the audit log of every console request.
 */
export function AdminPage({ me }: { me: MeResponse }) {
  const [tab, setTab] = useState<Tab>('workspaces');
  const [selected, setSelected] = useState<{ tab: Tab; id: string } | null>(null);
  const select = (id: string) => setSelected({ tab, id });
  const current = selected?.tab === tab ? selected.id : null;
  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <TopBar>
        <ShieldIcon aria-hidden className="size-4 text-text-2" />
        <h1 className="text-heading font-semibold">Ops console</h1>
      </TopBar>
      <main className="flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div role="tablist" aria-label="Ops console" className="mb-3 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'h-8 rounded-sm px-3 hover:bg-hover pointer-coarse:h-[40px]',
                tab === t.id && 'bg-selected font-[550] text-primary'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
          {tab === 'workspaces' && <WorkspacesTab selected={current} onSelect={select} />}
          {tab === 'users' && <UsersTab selected={current} onSelect={select} />}
          {tab === 'audit' && <AuditTab />}
          {current && tab !== 'audit' && (
            <aside className={cn(card, 'min-w-0 self-start')} aria-label="Details">
              {tab === 'workspaces' ? (
                <WorkspaceDetail key={current} workspaceId={current} />
              ) : (
                <UserDetail key={current} userId={current} />
              )}
            </aside>
          )}
        </div>
      </main>
    </Shell>
  );
}
