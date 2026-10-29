import { type MeResponse, TOKEN_SCOPE_DESCRIPTIONS } from '@openrows/shared';
import { PlugIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { ApiError } from '../../api/client';
import { useOAuthDecision, useOAuthRequest, useWorkspaces } from '../../api/queries';
import { Logo } from '../../app/Logo';
import { Button, Skeleton, toast } from '../../components/ui';
import { SignOutForm } from '../offline/SignOutForm';
import { WorkspaceGrant } from '../tokens/AccessTokens';
import { emptyDraft, type TokenDraft } from '../tokens/model';
import { consentQuery, initialGrant, redirectHost, safeRedirect } from './model';

/** The server's answer to a request it can't show; `redirectTo` when the app may hear why. */
function problemOf(err: unknown): { message: string; redirectTo: string | null } {
  if (err instanceof ApiError) {
    const back = (err.data as { redirectTo?: unknown } | undefined)?.redirectTo;
    return {
      message: err.message,
      redirectTo: typeof back === 'string' ? safeRedirect(back) : null,
    };
  }
  return { message: "Couldn't check this request.", redirectTo: null };
}

/**
 * The OAuth consent screen, `/oauth/authorize?client_id=…&redirect_uri=…&scope=…&state=…
 * &code_challenge=…&code_challenge_method=S256`: the app, what it asks for, where it sends you
 * back, and the workspaces or bases to give it. Allowing (or declining) asks the server for the
 * redirect, then leaves for the app. Signed-out visitors sign in first and come back.
 */
export function ConsentPage({ me, search }: { me: MeResponse; search: string }) {
  const query = consentQuery(search);
  const request = useOAuthRequest(query);
  const decide = useOAuthDecision();
  const workspaces = useWorkspaces();
  const [draft, setDraft] = useState<TokenDraft | null>(null);
  const [baseWorkspace] = useState(() => new Map<string, string>());

  if (request.isPending) {
    return (
      <Card>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="mt-3 h-24" />
      </Card>
    );
  }
  if (request.isError) {
    const { message, redirectTo } = problemOf(request.error);
    return (
      <Card title="Can't connect this app">
        <p className="text-text-2" role="alert">
          {message}
        </p>
        {redirectTo && (
          <Button
            className="mt-5"
            variant="secondary"
            onClick={() => window.location.assign(redirectTo)}
          >
            Back to the app
          </Button>
        )}
      </Card>
    );
  }

  const info = request.data;
  const grant = draft ?? { ...emptyDraft(), ...initialGrant(info), scopes: info.scopes };
  const answer = (decision: 'allow' | 'deny') => {
    const baseIds = grant.baseIds.filter(
      (b) => !grant.workspaceIds.includes(baseWorkspace.get(b) ?? '')
    );
    if (decision === 'allow' && grant.workspaceIds.length + baseIds.length === 0) {
      toast.error('Pick at least one workspace or base.');
      return;
    }
    decide.mutate(
      {
        clientId: info.clientId,
        redirectUri: info.redirectUri,
        scope: info.scopes.join(' '),
        ...(query['state'] !== undefined ? { state: query['state'] } : {}),
        codeChallenge: query['code_challenge'] ?? '',
        codeChallengeMethod: 'S256',
        decision,
        workspaceIds: decision === 'allow' ? grant.workspaceIds : [],
        baseIds: decision === 'allow' ? baseIds : [],
      },
      {
        onSuccess: ({ redirectTo }) => {
          const target = safeRedirect(redirectTo);
          if (target) window.location.assign(target);
        },
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.message : "Couldn't answer the request"),
      }
    );
  };

  return (
    <Card title={`Allow ${info.app.name} to access your data?`}>
      <p className="text-text-2">
        {info.app.homepageUrl ? (
          <a
            href={info.app.homepageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text underline underline-offset-2"
          >
            {info.app.name}
          </a>
        ) : (
          <strong className="text-text">{info.app.name}</strong>
        )}{' '}
        will act as <strong className="text-text">{me.user.email ?? me.user.name}</strong>, never
        with more than you can do, and send you back to{' '}
        <strong className="text-text">{redirectHost(info.redirectUri)}</strong>.
      </p>
      {info.app.description && (
        <p className="mt-2 text-small text-text-2 [overflow-wrap:anywhere]">
          {info.app.description}
        </p>
      )}
      <h2 className="mt-5 mb-1 font-[550]">It asks to</h2>
      <ul aria-label="Requested access" className="flex flex-col gap-1">
        {info.scopes.map((scope) => (
          <li key={scope} className="flex items-start gap-2">
            <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-text-2" />
            <span>
              {TOKEN_SCOPE_DESCRIPTIONS[scope]}{' '}
              <code className="font-mono text-small text-text-2">{scope}</code>
            </span>
          </li>
        ))}
      </ul>
      <fieldset className="mt-5 flex flex-col gap-2">
        <legend className="mb-1 font-[550]">Where</legend>
        {workspaces.isPending ? (
          <Skeleton className="h-8" />
        ) : (
          workspaces.data?.workspaces.map((w) => (
            <WorkspaceGrant
              key={w.id}
              workspace={w}
              draft={grant}
              onChange={setDraft}
              onBases={(ids) => {
                for (const id of ids) baseWorkspace.set(id, w.id);
              }}
            />
          ))
        )}
      </fieldset>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={decide.isPending} onClick={() => answer('deny')}>
          Cancel
        </Button>
        <Button disabled={decide.isPending} onClick={() => answer('allow')}>
          {decide.isPending ? 'Connecting…' : `Allow ${info.app.name}`}
        </Button>
      </div>
      <p className="mt-4 text-small text-text-2">
        You can revoke it any time in Settings → Integrations.{' '}
        <SignOutForm className="inline">
          <button type="submit" className="underline underline-offset-2 hover:text-text">
            Not you? Sign out
          </button>
        </SignOutForm>
      </p>
    </Card>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-8 shadow-1">
        <div className="mb-6 flex items-center justify-between">
          <Logo />
          <PlugIcon className="size-5 text-text-2" aria-hidden />
        </div>
        {title && (
          <h1 className="mb-2 text-title font-semibold [overflow-wrap:anywhere]">{title}</h1>
        )}
        {children}
      </div>
    </main>
  );
}
