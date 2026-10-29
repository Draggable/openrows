import type { WorkspacePolicies, WorkspacePoliciesState } from '@openrows/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { workspaceAdminApi } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { useAdminMembers, usePolicies } from '../../api/queries';
import { Button, Input, Skeleton, toast } from '../../components/ui';
import { errorText, ssoUnavailable } from '../sso/model';
import {
  accessText,
  checkPolicies,
  domainsText,
  filterMembers,
  lastActiveText,
  POLICY_SWITCHES,
  ROLE_NAMES,
} from './model';

const section = 'rounded-lg border border-border bg-surface p-5 shadow-1';
const link = 'text-primary underline underline-offset-2';

/**
 * The workspace admin console (`/w/:workspaceId/admin`), for its owners on the hosted
 * Enterprise plan: the policies (share links, forms, embeds, tokens, invitation domains; enforced
 * by the server, each change in the audit log), single sign-on and SCIM at a glance, and everyone
 * with access across the bases with their last activity. Self-hosted servers have none (404:
 * a note), other plans are told what they need.
 */
export function AdminConsole({ workspaceId }: { workspaceId: string }) {
  const policies = usePolicies(workspaceId);
  if (policies.isError) {
    return (
      <section className={section}>
        <h2 className="mb-1 text-heading font-semibold">Admin console</h2>
        <p className="text-text-2">
          {ssoUnavailable(policies.error) === 'edition'
            ? 'The admin console is part of OpenRows Cloud’s Enterprise plan.'
            : "Couldn't load the workspace's policies."}
        </p>
      </section>
    );
  }
  if (!policies.data) return <Skeleton className="h-80" />;
  const state = policies.data;
  return (
    <>
      {!state.available && (
        <p role="status" className="rounded-md border border-border bg-surface p-4 text-text">
          The admin console is part of the Enterprise plan.{' '}
          <Link to="/w/$workspaceId/billing" params={{ workspaceId }} className={link}>
            See the plans
          </Link>
          . Policies set before still apply; you can turn them off.
        </p>
      )}
      <PoliciesPanel workspaceId={workspaceId} state={state} />
      <IdentityPanel workspaceId={workspaceId} state={state} />
      {state.available && <MembersPanel workspaceId={workspaceId} />}
    </>
  );
}

function PoliciesPanel({
  workspaceId,
  state,
}: {
  workspaceId: string;
  state: WorkspacePoliciesState;
}) {
  const id = useId();
  const qc = useQueryClient();
  const initial = { ...state.policies, domains: domainsText(state.policies.inviteDomains) };
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: WorkspacePolicies) =>
      workspaceAdminApi.policies.update({ params: { workspaceId }, body }),
    onSuccess: (next) => {
      qc.setQueryData(queryKeys.workspaces.policies(workspaceId), next);
      setForm({ ...next.policies, domains: domainsText(next.policies.inviteDomains) });
      toast.success('Policies saved');
    },
    onError: (err) => setError(errorText(err, "Couldn't save the policies")),
  });
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const disabled = !state.available;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const checked = checkPolicies(form);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    save.mutate(checked.policies);
  }

  return (
    <section aria-labelledby={`${id}-title`} className={section}>
      <h2 id={`${id}-title`} className="mb-1 text-heading font-semibold">
        Policies
      </h2>
      <p className="mb-4 text-text-2">
        What people in this workspace may share and connect, on top of their roles. Changes apply at
        once and are kept in the{' '}
        <Link to="/w/$workspaceId/audit-log" params={{ workspaceId }} className={link}>
          audit log
        </Link>
        .
      </p>
      <form onSubmit={submit} className="grid gap-4">
        {POLICY_SWITCHES.map((p) => (
          <div key={p.key} className="grid gap-1">
            <label className="flex items-center gap-2 text-text">
              <input
                type="checkbox"
                checked={form[p.key]}
                // Without the plan, a restriction can only be lifted.
                disabled={disabled && form[p.key]}
                onChange={(e) => setForm((f) => ({ ...f, [p.key]: e.target.checked }))}
                className="size-4 accent-[var(--accent)]"
              />
              <span>{p.label}</span>
            </label>
            <p className="pl-6 text-small text-text-2">{p.help}</p>
          </div>
        ))}
        <div className="grid gap-1">
          <label htmlFor={`${id}-domains`} className="text-text">
            Invitations only to these email domains
          </label>
          <textarea
            id={`${id}-domains`}
            value={form.domains}
            disabled={disabled && form.domains.trim() === ''}
            onChange={(e) => setForm((f) => ({ ...f, domains: e.target.value }))}
            rows={3}
            placeholder="example.com"
            aria-describedby={`${id}-domains-help`}
            className="rounded-sm border border-border bg-surface px-2 py-1.5 text-body text-text hover:border-border-strong"
          />
          <p id={`${id}-domains-help`} className="text-small text-text-2">
            One per line. Empty: any address. Applies to invitations to the workspace, its bases and
            interfaces, and to pending ones when they're accepted.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setForm(initial);
              setError(null);
            }}
          >
            Discard
          </Button>
          <Button type="submit" disabled={!dirty || save.isPending}>
            Save policies
          </Button>
        </div>
      </form>
    </section>
  );
}

function IdentityPanel({
  workspaceId,
  state,
}: {
  workspaceId: string;
  state: WorkspacePoliciesState;
}) {
  const { sso, scim } = state;
  const ssoText = !sso.configured
    ? 'Not set up.'
    : !sso.enabled
      ? 'Set up, turned off.'
      : sso.requireSso
        ? 'On. Required for addresses on the verified domains.'
        : 'On. Not required: people on the verified domains may also sign in other ways.';
  return (
    <section aria-label="Single sign-on and SCIM" className={section}>
      <h2 className="mb-3 text-heading font-semibold">Single sign-on and SCIM</h2>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2">
        <dt className="text-text-2">Single sign-on</dt>
        <dd className="text-text" data-testid="sso-status">
          {ssoText}
        </dd>
        <dt className="text-text-2">SCIM provisioning</dt>
        <dd className="text-text" data-testid="scim-status">
          {scim.configured ? 'Connected (a token is set).' : 'Not connected.'}
        </dd>
      </dl>
      <p className="mt-3 text-small text-text-2">
        Require single sign-on, verify domains and connect SCIM on the{' '}
        <Link to="/w/$workspaceId/sso" params={{ workspaceId }} className={link}>
          single sign-on page
        </Link>
        .
      </p>
    </section>
  );
}

function MembersPanel({ workspaceId }: { workspaceId: string }) {
  const id = useId();
  const members = useAdminMembers(workspaceId);
  const [query, setQuery] = useState('');
  const shown = useMemo(
    () => filterMembers(members.data?.members ?? [], query),
    [members.data, query]
  );
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={`${id}-title`} className="text-heading font-semibold">
          People
        </h2>
        <span className="text-small text-text-2">
          {members.data ? `${members.data.members.length} with access` : ''}
        </span>
        <Input
          type="search"
          aria-label="Find people"
          placeholder="Find by name or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ml-auto w-60"
        />
      </div>
      {members.isError ? (
        <p role="alert" className="text-text-2">
          {errorText(members.error, "Couldn't load the people.")}
        </p>
      ) : !members.data ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-1">
          <table className="w-full text-left text-body">
            <caption className="sr-only">
              Everyone with access to the workspace or its bases
            </caption>
            <thead className="border-b border-border text-small text-text-2">
              <tr>
                <th scope="col" className="h-[34px] px-3 font-medium">
                  Person
                </th>
                <th scope="col" className="px-3 font-medium">
                  Workspace role
                </th>
                <th scope="col" className="px-3 font-medium">
                  Bases
                </th>
                <th scope="col" className="px-3 font-medium">
                  Last active
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.userId} className="border-b border-border align-top last:border-b-0">
                  <td className="px-3 py-2">
                    <div className="text-text">{m.name ?? m.email}</div>
                    {m.name && <div className="text-small text-text-2">{m.email}</div>}
                    {m.provisioned && (
                      <span className="mt-1 inline-block rounded-sm bg-app px-1.5 text-small text-text-2">
                        SCIM
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-text">
                    {m.workspaceRole ? ROLE_NAMES[m.workspaceRole] : 'Collaborator'}
                  </td>
                  <td className="px-3 py-2 text-text-2">
                    {m.bases.length > 0 && (
                      <ul className="grid gap-0.5">
                        {m.bases.map((b) => (
                          <li key={b.id}>
                            <span className="text-text">{b.name}</span> · {ROLE_NAMES[b.role]}
                          </li>
                        ))}
                      </ul>
                    )}
                    {m.baseCount > m.bases.length || m.interfaceCount > 0 ? (
                      <div className="text-small">{accessText(m)}</div>
                    ) : m.bases.length === 0 ? (
                      m.workspaceRole ? (
                        'Every base'
                      ) : (
                        ''
                      )
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-2">
                    {lastActiveText(m.lastActiveAt)}
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-text-2">
                    No one matches.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {members.data.truncated && (
            <p className="border-t border-border px-3 py-2 text-small text-text-2">
              Showing the first {members.data.members.length} people.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
