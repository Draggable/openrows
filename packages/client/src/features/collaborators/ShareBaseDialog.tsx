import {
  BASE_ROLES,
  type Base,
  type BaseCollaborator,
  type BaseRole,
  type Invitation,
} from '@openrows/shared';
import { MailIcon, RotateCwIcon, TrashIcon, UserMinusIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  useBaseCollaborators,
  useBaseInvitations,
  useInviteToBase,
  useRemoveBaseRole,
  useResendBaseInvitation,
  useRevokeBaseInvitation,
  useSetBaseRole,
} from '../../api/queries';
import { ROLE_LABELS } from '../../app/names';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  toast,
} from '../../components/ui';
import { ShareLinks } from '../share/ShareViewDialog';
import { accessSource, baseRoleChoices, removeLabel } from './share-model';

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

const selectClass =
  'h-8 rounded-sm border border-border bg-surface px-2 text-body hover:bg-hover disabled:opacity-60 pointer-coarse:h-[40px]';

/**
 * Share a base (creators and up): invite people to this base only, see everyone with
 * access and their effective role (the higher of workspace and base role), change base roles,
 * and manage pending base invitations.
 */
export function ShareBaseDialog({
  base,
  meId,
  open,
  onOpenChange,
}: {
  base: Base;
  meId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const people = useBaseCollaborators(base.id, open);
  const invitations = useBaseInvitations(base.id, open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Share {base.name}</DialogTitle>
          <DialogDescription>
            Invite people to this base only. Workspace members keep their workspace role; a base
            role can raise it here, never lower it.
          </DialogDescription>
        </DialogHeader>
        <InviteForm baseId={base.id} />
        <section aria-labelledby="share-people" className="grid gap-1">
          <h3 id="share-people" className="text-small font-semibold text-text-2">
            People with access{people.data ? ` (${people.data.collaborators.length})` : ''}
          </h3>
          {people.isPending ? (
            <div className="grid gap-2">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
            </div>
          ) : (
            <ul aria-label="People with access" className="grid">
              {people.data?.collaborators.map((c) => (
                <PersonRow key={c.userId} baseId={base.id} person={c} isMe={c.userId === meId} />
              ))}
            </ul>
          )}
        </section>
        {invitations.data && invitations.data.invitations.length > 0 && (
          <section aria-labelledby="share-invitations" className="grid gap-1">
            <h3 id="share-invitations" className="text-small font-semibold text-text-2">
              Pending invitations
            </h3>
            <ul aria-label="Pending base invitations" className="grid">
              {invitations.data.invitations.map((i) => (
                <InvitationRow key={i.id} baseId={base.id} invitation={i} />
              ))}
            </ul>
          </section>
        )}
        <section
          aria-labelledby="share-base-link"
          className="grid gap-2 border-t border-border pt-3"
        >
          <h3 id="share-base-link" className="text-small font-semibold text-text-2">
            Share link to the whole base
          </h3>
          <p className="text-small text-text-2">
            Anyone with the link sees every table and shared view of this base, read-only. Personal
            views and hidden fields stay private.
          </p>
          <ShareLinks target={{ kind: 'base', baseId: base.id }} open={open} name={base.name} />
        </section>
      </DialogContent>
    </Dialog>
  );
}

function InviteForm({ baseId }: { baseId: string }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<BaseRole>('editor');
  const invite = useInviteToBase(baseId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    invite.mutate(
      { email, role },
      {
        onSuccess: (inv) => {
          setEmail('');
          if (inv.emailSent === false) {
            toast.error(`Invitation saved, but the email to ${inv.email} could not be sent`);
          } else toast.success(`Invitation sent to ${inv.email}`);
        },
        onError: (err) => toast.error(errorText(err, "Couldn't send the invitation")),
      }
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <label htmlFor="share-email" className="sr-only">
        Email
      </label>
      <Input
        id="share-email"
        type="email"
        required
        autoFocus
        placeholder="name@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="min-w-48 flex-1"
      />
      <label htmlFor="share-role" className="sr-only">
        Role on this base
      </label>
      <select
        id="share-role"
        value={role}
        onChange={(e) => setRole(e.target.value as BaseRole)}
        className={selectClass}
      >
        {BASE_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      <Button type="submit" disabled={invite.isPending || !email.trim()}>
        <MailIcon />
        {invite.isPending ? 'Sending…' : 'Invite'}
      </Button>
    </form>
  );
}

function PersonRow({
  baseId,
  person,
  isMe,
}: {
  baseId: string;
  person: BaseCollaborator;
  isMe: boolean;
}) {
  const setRole = useSetBaseRole(baseId);
  const remove = useRemoveBaseRole(baseId);
  const label = person.name ?? person.email ?? 'Unknown user';
  const choices = baseRoleChoices(person);
  const busy = setRole.isPending || remove.isPending;

  return (
    <li className="flex min-h-[48px] items-center gap-3 border-t border-border py-1.5">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-hover text-small font-semibold text-text-2"
      >
        {label.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-[550]">
          {label}
          {isMe && <span className="font-normal text-text-2"> (you)</span>}
        </span>
        <span className="block truncate text-small text-text-2">
          {person.name && person.email ? `${person.email} · ` : ''}
          {accessSource(person)}
        </span>
      </span>
      {choices.length > 0 ? (
        <>
          <label htmlFor={`share-role-${person.userId}`} className="sr-only">
            Role of {label} on this base
          </label>
          <select
            id={`share-role-${person.userId}`}
            value={person.role}
            disabled={busy}
            onChange={(e) =>
              setRole.mutate(
                { userId: person.userId, role: e.target.value as BaseRole },
                { onError: (err) => toast.error(errorText(err, "Couldn't change the role")) }
              )
            }
            className={selectClass}
          >
            {choices.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          {person.baseRole !== null && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`${removeLabel(person)}: ${label}`}
              title={removeLabel(person)}
              disabled={busy}
              onClick={() =>
                remove.mutate(person.userId, {
                  onSuccess: () =>
                    toast.success(
                      person.workspaceRole === null
                        ? `Removed ${label} from the base`
                        : `${label} is back to their workspace role`
                    ),
                  onError: (err) => toast.error(errorText(err, "Couldn't remove the role")),
                })
              }
            >
              <UserMinusIcon />
            </Button>
          )}
        </>
      ) : (
        <span className="font-[550]">{ROLE_LABELS[person.role]}</span>
      )}
    </li>
  );
}

function InvitationRow({ baseId, invitation }: { baseId: string; invitation: Invitation }) {
  const resend = useResendBaseInvitation(baseId);
  const revoke = useRevokeBaseInvitation(baseId);
  const expired = new Date(invitation.expiresAt).getTime() <= Date.now();
  return (
    <li className="flex min-h-[48px] items-center gap-3 border-t border-border py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-[550]">{invitation.email}</span>
        <span className="block truncate text-small text-text-2">
          {ROLE_LABELS[invitation.role]} ·{' '}
          {expired ? 'Expired' : `Sent ${new Date(invitation.sentAt).toLocaleDateString()}`}
        </span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={resend.isPending}
        onClick={() =>
          resend.mutate(invitation.id, {
            onSuccess: (inv) =>
              inv.emailSent === false
                ? toast.error(`The email to ${inv.email} could not be sent`)
                : toast.success(`Sent again to ${inv.email}`),
            onError: (err) => toast.error(errorText(err, "Couldn't resend")),
          })
        }
      >
        <RotateCwIcon />
        Resend
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Revoke the invitation for ${invitation.email}`}
        disabled={revoke.isPending}
        onClick={() =>
          revoke.mutate(invitation.id, {
            onError: (err) => toast.error(errorText(err, "Couldn't revoke")),
          })
        }
      >
        <TrashIcon />
      </Button>
    </li>
  );
}
