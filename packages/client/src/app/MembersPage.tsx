import {
  type Invitation,
  type Member,
  type MeResponse,
  USER_ROLES,
  type UserRole,
} from '@openrows/shared';
import { MailIcon, RotateCwIcon, TrashIcon, UserMinusIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import {
  useInvitations,
  useInvite,
  useMembers,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  useUpdateMember,
  useWorkspace,
} from '../api/queries';
import { Button, Input, Skeleton, toast } from '../components/ui';
import { cn } from '../lib/utils';
import { HomeSidebar } from './HomeSidebar';
import { ROLE_LABELS } from './names';
import { Shell, TopBar } from './Shell';

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/** The roles `actor` may hand out: only owners grant owner. */
function grantable(actor: UserRole): readonly UserRole[] {
  return actor === 'owner' ? USER_ROLES : USER_ROLES.filter((r) => r !== 'owner');
}

const selectClass =
  'h-8 rounded-sm border border-border bg-surface px-2 text-body hover:bg-hover disabled:opacity-60 pointer-coarse:h-[40px]';

/** `/w/:workspaceId/members`: members, their roles, invitations. */
export function MembersPage({ me, workspaceId }: { me: MeResponse; workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const role = workspace.data?.role;
  const canManage = role === 'owner' || role === 'creator';
  const members = useMembers(workspaceId);
  const invitations = useInvitations(workspaceId, canManage);

  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <TopBar>
        <h1 className="truncate text-heading font-semibold">
          {workspace.data ? `${workspace.data.name} · Members` : 'Members'}
        </h1>
      </TopBar>
      <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
          {canManage && role && <InviteForm workspaceId={workspaceId} actor={role} />}
          <section
            aria-labelledby="members-heading"
            className="rounded-lg border border-border bg-surface shadow-1"
          >
            <h2 id="members-heading" className="px-5 pt-4 pb-2 text-heading font-semibold">
              Members{members.data ? ` (${members.data.members.length})` : ''}
            </h2>
            {members.isPending ? (
              <div className="grid gap-2 px-5 pb-4">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : (
              <ul aria-label="Members">
                {members.data?.members.map((m) => (
                  <MemberRow
                    key={m.userId}
                    workspaceId={workspaceId}
                    member={m}
                    actor={canManage ? role : undefined}
                    isMe={m.userId === me.user.id}
                  />
                ))}
              </ul>
            )}
          </section>
          {canManage && role && (
            <section
              aria-labelledby="invitations-heading"
              className="rounded-lg border border-border bg-surface shadow-1"
            >
              <h2 id="invitations-heading" className="px-5 pt-4 pb-2 text-heading font-semibold">
                Pending invitations
              </h2>
              {invitations.data?.invitations.length ? (
                <ul aria-label="Pending invitations">
                  {invitations.data.invitations.map((i) => (
                    <InvitationRow
                      key={i.id}
                      workspaceId={workspaceId}
                      invitation={i}
                      actor={role}
                    />
                  ))}
                </ul>
              ) : (
                <p className="px-5 pb-4 text-text-2">
                  {invitations.isPending ? 'Loading…' : 'No pending invitations.'}
                </p>
              )}
            </section>
          )}
        </div>
      </main>
    </Shell>
  );
}

function InviteForm({ workspaceId, actor }: { workspaceId: string; actor: UserRole }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('editor');
  const invite = useInvite(workspaceId);

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
    <section
      aria-labelledby="invite-heading"
      className="rounded-lg border border-border bg-surface p-5 shadow-1"
    >
      <h2 id="invite-heading" className="text-heading font-semibold">
        Invite people
      </h2>
      <p className="mt-1 text-text-2">
        They get an email with a link. It works for 7 days and only for that address.
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor="invite-email" className="sr-only">
          Email
        </label>
        <Input
          id="invite-email"
          type="email"
          required
          placeholder="name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-w-48 flex-1 sm:min-w-64"
        />
        <label htmlFor="invite-role" className="sr-only">
          Role
        </label>
        <select
          id="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          className={selectClass}
        >
          {grantable(actor).map((r) => (
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
    </section>
  );
}

function MemberRow({
  workspaceId,
  member,
  actor,
  isMe,
}: {
  workspaceId: string;
  member: Member;
  /** The caller's role when they may manage members. */
  actor: UserRole | undefined;
  isMe: boolean;
}) {
  const update = useUpdateMember(workspaceId);
  const remove = useRemoveMember(workspaceId);
  const label = member.name ?? member.email ?? 'Unknown user';
  // Only owners touch owners; the server enforces it (and keeps one owner) either way.
  const editable = actor !== undefined && (actor === 'owner' || member.role !== 'owner');

  return (
    <li className="flex h-[52px] items-center gap-3 border-t border-border px-5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-hover text-small font-semibold text-text-2">
        {label.slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-[550]">
          {label}
          {isMe && <span className="font-normal text-text-2"> (you)</span>}
        </span>
        {member.name && member.email && (
          <span className="block truncate text-small text-text-2">{member.email}</span>
        )}
      </span>
      {editable && actor ? (
        <>
          <label htmlFor={`role-${member.userId}`} className="sr-only">
            Role of {label}
          </label>
          <select
            id={`role-${member.userId}`}
            value={member.role}
            disabled={update.isPending}
            onChange={(e) =>
              update.mutate(
                { userId: member.userId, role: e.target.value as UserRole },
                { onError: (err) => toast.error(errorText(err, "Couldn't change the role")) }
              )
            }
            className={selectClass}
          >
            {grantable(actor).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
            {!grantable(actor).includes(member.role) && (
              <option value={member.role}>{ROLE_LABELS[member.role]}</option>
            )}
          </select>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${label}`}
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(member.userId, {
                onSuccess: () => toast.success(`Removed ${label}`),
                onError: (err) => toast.error(errorText(err, "Couldn't remove the member")),
              })
            }
          >
            <UserMinusIcon />
          </Button>
        </>
      ) : (
        <span className={cn('text-text-2', member.role === 'owner' && 'font-[550] text-text')}>
          {ROLE_LABELS[member.role]}
        </span>
      )}
    </li>
  );
}

function InvitationRow({
  workspaceId,
  invitation,
  actor,
}: {
  workspaceId: string;
  invitation: Invitation;
  actor: UserRole;
}) {
  const resend = useResendInvitation(workspaceId);
  const revoke = useRevokeInvitation(workspaceId);
  const expired = new Date(invitation.expiresAt).getTime() <= Date.now();
  const allowed = actor === 'owner' || invitation.role !== 'owner';

  return (
    <li className="flex h-[52px] items-center gap-3 border-t border-border px-5">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-[550]">{invitation.email}</span>
        <span className="block truncate text-small text-text-2">
          {ROLE_LABELS[invitation.role]} ·{' '}
          {expired
            ? 'Expired'
            : `Sent ${new Date(invitation.sentAt).toLocaleDateString()}${invitation.invitedByName ? ` by ${invitation.invitedByName}` : ''}`}
        </span>
      </span>
      {allowed && (
        <>
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
        </>
      )}
    </li>
  );
}
