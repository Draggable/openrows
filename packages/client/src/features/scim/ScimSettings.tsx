import { SCIM_ROLES, type ScimGroupSummary, type ScimRole, type ScimState } from '@openrows/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CopyIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { scimApi } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { useScim } from '../../api/queries';
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
import { errorText, ROLE_LABELS, ssoUnavailable } from '../sso/model';
import { NO_ROLE, tokenText, usersText } from './model';

const section = 'rounded-lg border border-border bg-surface p-5 shadow-1';
const label = 'text-small text-text-2';
const selectClass =
  'h-8 rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/**
 * Settings → SCIM provisioning, under single sign-on, for a workspace's owners on a plan
 * with `scim`: the base URL and bearer token for the identity provider (shown once; rotate or
 * revoke), the role provisioned people get, and the roles the provider's groups map to.
 * Self-hosted servers have none (404: nothing shown) and other plans are told what they need.
 */
export function ScimSettings({ workspaceId }: { workspaceId: string }) {
  const scim = useScim(workspaceId);
  if (scim.isError) {
    const why = ssoUnavailable(scim.error);
    if (why === 'edition') return null;
    return (
      <section className={section}>
        <h2 className="mb-1 text-heading font-semibold">SCIM provisioning</h2>
        <p className="text-text-2">
          {why === 'plan'
            ? 'Provisioning people and groups from your identity provider with SCIM is part of the Business and Enterprise plans.'
            : "Couldn't load the SCIM settings."}
        </p>
      </section>
    );
  }
  if (!scim.data) return <Skeleton className="h-48" />;
  return <ScimPanel workspaceId={workspaceId} state={scim.data} />;
}

function ScimPanel({ workspaceId, state }: { workspaceId: string; state: ScimState }) {
  const id = useId();
  const qc = useQueryClient();
  const key = queryKeys.workspaces.scim(workspaceId);
  const [created, setCreated] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const create = useMutation({
    mutationFn: () => scimApi.token.create({ params: { workspaceId } }),
    onSuccess: (r) => {
      qc.setQueryData(key, r.state);
      setCreated(r.token);
    },
    onError: (err) => toast.error(errorText(err, "Couldn't create the token")),
  });
  const revoke = useMutation({
    mutationFn: () => scimApi.token.revoke({ params: { workspaceId } }),
    onSuccess: () => {
      qc.setQueryData<ScimState>(key, (s) => (s ? { ...s, token: null } : s));
      setConfirmRevoke(false);
      toast.success('SCIM token revoked');
    },
    onError: (err) => toast.error(errorText(err, "Couldn't revoke the token")),
  });
  const update = useMutation({
    mutationFn: (defaultRole: ScimRole) =>
      scimApi.settings.update({ params: { workspaceId }, body: { defaultRole } }),
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.success('Default role saved');
    },
    onError: (err) => toast.error(errorText(err, "Couldn't change the default role")),
  });

  return (
    <section aria-labelledby={`${id}-title`} className={section}>
      <h2 id={`${id}-title`} className="mb-1 text-heading font-semibold">
        SCIM provisioning
      </h2>
      <p className="mb-4 text-text-2">
        Let your identity provider (Okta, Microsoft Entra ID and others) add, update and deactivate
        the workspace's people and groups. Deactivated people leave the workspace and are signed out
        everywhere. Owners are never changed by provisioning.
      </p>
      {state.verifiedDomains.length === 0 && (
        <p role="status" className="mb-4 rounded-sm bg-app p-3 text-small text-text">
          Verify an email domain above first: provisioned people need an address on one of the
          workspace's verified domains.
        </p>
      )}
      <div className="mb-5 grid gap-3 rounded-md border border-border p-3">
        <Copyable name="SCIM base URL" value={state.baseUrl} />
        <div className="grid gap-2">
          <span className={label}>Bearer token</span>
          {state.token ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text" data-testid="scim-token">
                {tokenText(state.token)}
              </span>
              <span className="ml-auto flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={create.isPending}
                  onClick={() => create.mutate()}
                >
                  Rotate token
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke(true)}>
                  Revoke
                </Button>
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text-2">No token: the identity provider can't connect.</span>
              <Button
                size="sm"
                className="ml-auto"
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                Generate token
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="mb-5 grid gap-1">
        <label htmlFor={`${id}-default`} className={label}>
          Role for people in no mapped group
        </label>
        <select
          id={`${id}-default`}
          className={`${selectClass} w-48`}
          value={state.defaultRole}
          disabled={update.isPending}
          onChange={(e) => update.mutate(e.target.value as ScimRole)}
        >
          {SCIM_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <p className="text-small text-text-2" data-testid="scim-users">
          {usersText(state.users)}
        </p>
      </div>

      <h3 className="mb-2 font-semibold text-text">Groups</h3>
      {state.groups.length === 0 ? (
        <p className="text-text-2">
          No groups yet. Groups your identity provider pushes appear here, to map to roles.
        </p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border text-small text-text-2">
              <th className="py-1.5 font-normal">Group</th>
              <th className="py-1.5 font-normal">Members</th>
              <th className="py-1.5 font-normal">Role</th>
            </tr>
          </thead>
          <tbody>
            {state.groups.map((g) => (
              <GroupRow key={g.id} workspaceId={workspaceId} group={g} />
            ))}
          </tbody>
        </table>
      )}

      {created && <CreatedTokenDialog token={created} onClose={() => setCreated(null)} />}
      {confirmRevoke && (
        <Dialog open onOpenChange={(open) => !open && setConfirmRevoke(false)}>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>Revoke the SCIM token?</DialogTitle>
              <DialogDescription>
                Your identity provider can't provision anyone until you generate a new token and
                enter it there. People already provisioned stay as they are.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setConfirmRevoke(false)}>
                Cancel
              </Button>
              <Button disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                Revoke token
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function GroupRow({ workspaceId, group }: { workspaceId: string; group: ScimGroupSummary }) {
  const qc = useQueryClient();
  const id = useId();
  const setRole = useMutation({
    mutationFn: (role: ScimRole | null) =>
      scimApi.groups.update({ params: { workspaceId, groupId: group.id }, body: { role } }),
    onSuccess: (g) => {
      qc.setQueryData<ScimState>(queryKeys.workspaces.scim(workspaceId), (s) =>
        s ? { ...s, groups: s.groups.map((x) => (x.id === g.id ? g : x)) } : s
      );
      toast.success(`${g.displayName}: role saved`);
    },
    onError: (err) => toast.error(errorText(err, "Couldn't change the group's role")),
  });
  return (
    <tr className="h-[34px] border-b border-border last:border-0">
      <td className="pr-3 text-text">
        <label htmlFor={id}>{group.displayName}</label>
      </td>
      <td className="pr-3 text-text-2">{group.members}</td>
      <td>
        <select
          id={id}
          className={selectClass}
          value={group.role ?? NO_ROLE}
          disabled={setRole.isPending}
          onChange={(e) =>
            setRole.mutate(e.target.value === NO_ROLE ? null : (e.target.value as ScimRole))
          }
        >
          <option value={NO_ROLE}>No role (default)</option>
          {SCIM_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );
}

function Copyable({ name, value }: { name: string; value: string }) {
  return (
    <div className="grid gap-1">
      <span className={label}>{name}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-sm bg-app px-2 py-1 text-small">
          {value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Copy ${name}`}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => toast.success('Copied'));
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

function CreatedTokenDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const fieldId = useId();
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      toast.success('Token copied');
    } catch {
      toast.error("Couldn't copy. Select the token and copy it.");
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Copy your SCIM token</DialogTitle>
          <DialogDescription>
            This is the only time it's shown. Enter it as the bearer token (API token) in your
            identity provider's SCIM settings; any previous token has stopped working.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <label htmlFor={fieldId} className="sr-only">
            SCIM token
          </label>
          <Input
            id={fieldId}
            readOnly
            value={token}
            className="font-mono text-small"
            onFocus={(e) => e.target.select()}
          />
          <Button variant="secondary" onClick={onCopy}>
            <CopyIcon />
            Copy
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
