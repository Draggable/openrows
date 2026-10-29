import type { AccountWorkspace } from '@openrows/shared';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import { useAccountDeletion, useDeleteAccount } from '../../api/queries';
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
} from '../../components/ui';
import { deletionBlocked, emailMatches, OPEN_PARAM, reauthHref, workspaceOutcome } from './model';

/** Settings → "Delete account": the section and its confirmation dialog. */
export function DeleteAccount() {
  // Back from the provider's password prompt (`?delete-account=1`): reopen the dialog.
  const [open, setOpen] = useState(
    () => new URLSearchParams(window.location.search).get(OPEN_PARAM) === '1'
  );
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(OPEN_PARAM)) return;
    url.searchParams.delete(OPEN_PARAM);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }, []);
  return (
    <section
      aria-labelledby="settings-delete-account"
      className="rounded-lg border border-border bg-surface p-5 shadow-1"
    >
      <h2 id="settings-delete-account" className="text-heading font-semibold">
        Delete account
      </h2>
      <p className="mt-2 text-text-2">
        Signs you out everywhere and permanently deletes your profile and the workspaces only you
        are in, with their bases, records and files. Export your data first if you want a copy.
      </p>
      <Button variant="destructive" className="mt-4" onClick={() => setOpen(true)}>
        Delete account…
      </Button>
      {open && <DeleteAccountDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

function WorkspaceRow({ w }: { w: AccountWorkspace }) {
  return (
    <li className="flex flex-col gap-0.5 py-2">
      <span className="font-[550] [overflow-wrap:anywhere]">{w.name}</span>
      <span className={w.outcome === 'blocked' ? 'text-danger' : 'text-text-2'}>
        {workspaceOutcome(w)}
        {w.outcome === 'blocked' && (
          <>
            {' '}
            <Link
              to="/w/$workspaceId/members"
              params={{ workspaceId: w.id }}
              className="underline underline-offset-2"
            >
              Members
            </Link>
          </>
        )}
      </span>
    </li>
  );
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const preview = useAccountDeletion(true);
  const remove = useDeleteAccount();
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const data = preview.data;
  const blocked = data ? deletionBlocked(data) : false;
  const recent = data?.reauthenticatedUntil !== null && data !== undefined;
  const canDelete = data !== undefined && recent && !blocked && emailMatches(data.email, typed);
  const error =
    remove.error instanceof ApiError
      ? remove.error.message
      : remove.error
        ? "Couldn't delete your account. Please try again."
        : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete your account?</DialogTitle>
          <DialogDescription>
            This can't be undone. You're signed out everywhere and your data is permanently deleted
            within 30 days (usually within minutes); encrypted backups age out within a further 30
            days.
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          preview.isError ? (
            <p role="alert">Couldn't load your workspaces. Close this and try again.</p>
          ) : (
            <Skeleton className="h-16" />
          )
        ) : (
          <form
            id="delete-account-form"
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canDelete) return;
              remove.mutate(
                { confirmEmail: typed },
                {
                  onSuccess: () => window.location.assign('/login?error=account_deleted'),
                  onError: () => void preview.refetch(),
                }
              );
            }}
          >
            {data.workspaces.length > 0 && (
              <div>
                <h3 className="font-semibold">Workspaces you own</h3>
                <ul className="divide-y divide-border">
                  {data.workspaces.map((w) => (
                    <WorkspaceRow key={w.id} w={w} />
                  ))}
                </ul>
              </div>
            )}
            {!recent ? (
              <div className="flex flex-col gap-2">
                <p>For your security, enter your password again before deleting your account.</p>
                <Button
                  type="button"
                  variant="secondary"
                  className="self-start"
                  onClick={() => window.location.assign(reauthHref())}
                >
                  Confirm it's you
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label htmlFor={inputId}>
                  Type <strong className="[overflow-wrap:anywhere]">{data.email}</strong> to confirm
                </label>
                <Input
                  id={inputId}
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  disabled={blocked}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            )}
            {error && <p role="alert">{error}</p>}
          </form>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="delete-account-form"
            variant="destructive"
            disabled={!canDelete || remove.isPending}
          >
            {remove.isPending ? 'Deleting…' : 'Delete my account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
