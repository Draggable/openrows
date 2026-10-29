import { INTERFACE_ROLES, type InterfaceRole } from '@openrows/shared';
import { MailIcon, TrashIcon, UserMinusIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../api/client';
import { useInterfaceCollaboratorMutations, useInterfaceCollaborators } from '../../api/queries';
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

const selectClass =
  'h-8 rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

export const INTERFACE_ROLE_LABELS: Record<InterfaceRole, string> = {
  editor: 'Can edit',
  read_only: 'Can view',
};

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/**
 * "Share interface" (creators): invite people to this interface only. They see its
 * published pages, never the base, its grid or other interfaces; "Can edit" lets them change the
 * fields a page makes editable and submit its forms.
 */
export function ShareInterfaceDialog({
  interfaceId,
  name,
  open,
  onOpenChange,
}: {
  interfaceId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const list = useInterfaceCollaborators(interfaceId, open);
  const m = useInterfaceCollaboratorMutations(interfaceId);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InterfaceRole>('read_only');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    m.invite.mutate(
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Share {name}</DialogTitle>
          <DialogDescription>
            Invite people to this interface only: they see its published pages, not the base or its
            other interfaces. Everyone on the base sees it already.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
          <label htmlFor="interface-share-email" className="sr-only">
            Email
          </label>
          <Input
            id="interface-share-email"
            type="email"
            required
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-w-48 flex-1"
          />
          <label htmlFor="interface-share-role" className="sr-only">
            Access to this interface
          </label>
          <select
            id="interface-share-role"
            value={role}
            onChange={(e) => setRole(e.target.value as InterfaceRole)}
            className={selectClass}
          >
            {INTERFACE_ROLES.map((r) => (
              <option key={r} value={r}>
                {INTERFACE_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={m.invite.isPending || !email.trim()}>
            <MailIcon />
            {m.invite.isPending ? 'Sending…' : 'Invite'}
          </Button>
        </form>
        <section aria-labelledby="interface-people" className="grid gap-1">
          <h3 id="interface-people" className="text-small font-semibold text-text-2">
            Interface-only collaborators
            {list.data ? ` (${list.data.collaborators.length})` : ''}
          </h3>
          {list.isPending ? (
            <Skeleton className="h-8" />
          ) : list.data && list.data.collaborators.length === 0 ? (
            <p className="text-small text-text-2">Nobody yet.</p>
          ) : (
            <ul aria-label="Interface-only collaborators" className="grid">
              {list.data?.collaborators.map((c) => {
                const label = c.name ?? c.email ?? 'Unknown user';
                return (
                  <li
                    key={c.userId}
                    className="flex min-h-[44px] items-center gap-3 border-t border-border py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-[550]">{label}</span>
                      {c.email && c.name && (
                        <span className="block truncate text-small text-text-2">{c.email}</span>
                      )}
                    </span>
                    <label htmlFor={`interface-role-${c.userId}`} className="sr-only">
                      {label}'s access
                    </label>
                    <select
                      id={`interface-role-${c.userId}`}
                      value={c.role}
                      className={selectClass}
                      onChange={(e) =>
                        m.setRole.mutate(
                          { userId: c.userId, role: e.target.value as InterfaceRole },
                          { onError: (err) => toast.error(errorText(err, "Couldn't change it")) }
                        )
                      }
                    >
                      {INTERFACE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {INTERFACE_ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${label}`}
                      onClick={() =>
                        m.remove.mutate(c.userId, {
                          onError: (err) => toast.error(errorText(err, "Couldn't remove them")),
                        })
                      }
                    >
                      <UserMinusIcon />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {list.data && list.data.invitations.length > 0 && (
          <section aria-labelledby="interface-invitations" className="grid gap-1">
            <h3 id="interface-invitations" className="text-small font-semibold text-text-2">
              Pending invitations
            </h3>
            <ul aria-label="Pending interface invitations" className="grid">
              {list.data.invitations.map((i) => (
                <li
                  key={i.id}
                  className="flex min-h-[40px] items-center gap-3 border-t border-border py-1"
                >
                  <span className="min-w-0 flex-1 truncate">{i.email}</span>
                  <span className="text-small text-text-2">
                    {INTERFACE_ROLE_LABELS[i.role as InterfaceRole] ?? i.role}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke the invitation to ${i.email}`}
                    onClick={() =>
                      m.revoke.mutate(i.id, {
                        onError: (err) => toast.error(errorText(err, "Couldn't revoke it")),
                      })
                    }
                  >
                    <TrashIcon />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
