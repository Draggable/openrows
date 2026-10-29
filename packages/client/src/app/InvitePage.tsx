import type { InvitationPreview, MeResponse } from '@openrows/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { MailIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';
import { useAcceptInvitation, useInvitationPreview } from '../api/queries';
import { Button, buttonVariants, Spinner, toast } from '../components/ui';
import { SignOutForm } from '../features/offline/SignOutForm';
import { Logo } from './Logo';
import { ROLE_LABELS } from './names';

/**
 * `/invite/:token`: the link from an invitation email. Signed-out visitors are sent to
 * sign in first (the authed route's guard, with `returnTo`); then they see the invitation and
 * accept it, which needs their verified email to be the invited one.
 */
export function InvitePage({ me, token }: { me: MeResponse; token: string }) {
  const preview = useInvitationPreview(token);
  if (preview.isPending) {
    return (
      <Card>
        <Spinner />
      </Card>
    );
  }
  if (preview.isError || !preview.data) {
    const notFound = preview.error instanceof ApiError && preview.error.status === 404;
    return (
      <Card title={notFound ? 'This invitation link is not valid' : 'Something went wrong'}>
        <p className="text-text-2">
          {notFound
            ? 'It may have been resent, which replaces the old link. Ask for a new invitation.'
            : 'The invitation could not be loaded. Try again in a moment.'}
        </p>
        <HomeLink />
      </Card>
    );
  }
  return <Invitation me={me} token={token} invitation={preview.data} />;
}

function Invitation({
  me,
  token,
  invitation: inv,
}: {
  me: MeResponse;
  token: string;
  invitation: InvitationPreview;
}) {
  const accept = useAcceptInvitation(token);
  const navigate = useNavigate();
  // An interface invitation opens that interface; a base invitation that base; a
  // workspace invitation the workspace.
  const open = () =>
    inv.interfaceId
      ? navigate({ to: '/i/$interfaceId', params: { interfaceId: inv.interfaceId } })
      : inv.baseId
        ? navigate({ to: '/b/$baseId', params: { baseId: inv.baseId } })
        : navigate({ to: '/w/$workspaceId', params: { workspaceId: inv.workspaceId } });
  const target = inv.interfaceName ?? inv.baseName ?? inv.workspaceName;
  const title = `Join ${target}`;
  const intro = (
    <p className="text-text-2">
      {inv.inviterName ?? 'Someone'} invited <strong className="text-text">{inv.email}</strong> to{' '}
      {inv.interfaceName !== null ? (
        <>
          the interface <strong className="text-text">{inv.interfaceName}</strong> in{' '}
          {inv.workspaceName}
        </>
      ) : inv.baseName !== null ? (
        <>
          the base <strong className="text-text">{inv.baseName}</strong> in {inv.workspaceName}
        </>
      ) : (
        <>
          the workspace <strong className="text-text">{inv.workspaceName}</strong>
        </>
      )}{' '}
      {inv.interfaceName !== null
        ? inv.role === 'editor'
          ? 'to view and edit.'
          : 'to view.'
        : `as ${ROLE_LABELS[inv.role].toLowerCase()}.`}
    </p>
  );

  if (inv.alreadyMember) {
    return (
      <Card title={title}>
        <p className="text-text-2">
          {inv.interfaceName !== null
            ? `You already have access to ${inv.interfaceName}.`
            : inv.baseName !== null
              ? `You already have access to ${inv.baseName}.`
              : `You're already a member of ${inv.workspaceName}.`}
        </p>
        <Button className="mt-5" onClick={open}>
          {inv.interfaceName !== null
            ? 'Open interface'
            : inv.baseName !== null
              ? 'Open base'
              : 'Open workspace'}
        </Button>
      </Card>
    );
  }
  if (inv.status !== 'pending') {
    const why = {
      expired: 'This invitation has expired. Ask whoever invited you to send it again.',
      revoked: 'This invitation was revoked.',
      accepted: 'This invitation has already been used.',
    }[inv.status];
    return (
      <Card title={title}>
        {intro}
        <p className="mt-3">{why}</p>
        <HomeLink />
      </Card>
    );
  }
  if (!inv.emailMatches) {
    return (
      <Card title={title}>
        {intro}
        <p className="mt-3">
          You're signed in as <strong>{me.user.email ?? 'another account'}</strong>. Sign in with{' '}
          {inv.email} to accept it.
        </p>
        <SignOutForm className="mt-5">
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </SignOutForm>
      </Card>
    );
  }
  return (
    <Card title={title}>
      {intro}
      <Button
        className="mt-5"
        size="lg"
        disabled={accept.isPending}
        onClick={() =>
          accept.mutate(undefined, {
            onSuccess: () => {
              toast.success(`You joined ${target}`);
              void open();
            },
            onError: (err) =>
              toast.error(err instanceof ApiError ? err.message : "Couldn't accept the invitation"),
          })
        }
      >
        {accept.isPending ? 'Joining…' : 'Accept invitation'}
      </Button>
    </Card>
  );
}

function HomeLink() {
  return (
    <Link to="/" className={buttonVariants({ variant: 'secondary', className: 'mt-5' })}>
      Go to home
    </Link>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 shadow-1">
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <MailIcon className="size-5 text-text-2" aria-hidden />
        </div>
        {title && <h1 className="mb-2 text-title font-semibold">{title}</h1>}
        {children}
      </div>
    </main>
  );
}
