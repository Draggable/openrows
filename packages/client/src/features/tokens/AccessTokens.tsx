import {
  type AccessToken,
  type CreatedAccessToken,
  TOKEN_SCOPE_DESCRIPTIONS,
  type Workspace,
} from '@openrows/shared';
import { CopyIcon, KeyRoundIcon, PlusIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  useAccessTokens,
  useBases,
  useCreateAccessToken,
  useRevokeAccessToken,
  useWorkspaces,
} from '../../api/queries';
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
import { API_DOCS_PATH } from '../api-docs/ApiDocsPage';
import {
  draftProblem,
  EXPIRY_OPTIONS,
  emptyDraft,
  grantSummary,
  isExpired,
  SCOPE_ORDER,
  type TokenDraft,
  toggle,
  toRequest,
  usageSummary,
} from './model';

const utcDay = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

/** A token's requests per UTC day: the totals, and each day on demand. */
function TokenUsage({ token }: { token: AccessToken }) {
  return (
    <details className="text-small text-text-2" data-testid="token-usage">
      <summary className="w-fit cursor-pointer rounded-xs hover:text-text">
        {usageSummary(token)}
      </summary>
      <table className="mt-1 tabular-nums">
        <caption className="sr-only">Requests per day (UTC) with {token.name}</caption>
        <tbody>
          {token.usage.map((d) => (
            <tr key={d.day}>
              <th scope="row" className="pr-3 text-left font-normal">
                {utcDay(d.day)}
              </th>
              <td className="text-right">{d.requests.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

const selectClass =
  'h-8 rounded-sm border border-border bg-surface px-2 text-body hover:bg-hover disabled:opacity-60 pointer-coarse:h-[40px]';
const checkboxClass = 'size-4 shrink-0 accent-[var(--accent)]';

/**
 * Settings → Developer: personal access tokens. Lists the user's tokens (never their
 * secrets) with when each was last used and its requests per day, creates one (name, scopes, workspaces or bases,
 * expiry) and shows its secret once, and revokes.
 */
export function AccessTokens() {
  const list = useAccessTokens();
  const revoke = useRevokeAccessToken();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedAccessToken | null>(null);

  const onRevoke = (t: AccessToken) => {
    if (!window.confirm(`Revoke "${t.name}"? Anything using it stops working right away.`)) return;
    revoke.mutate(t.id, {
      onSuccess: () => toast.success('Token revoked'),
      onError: (err) => toast.error(message(err, "Couldn't revoke the token")),
    });
  };

  return (
    <section
      aria-labelledby="settings-tokens"
      className="rounded-lg border border-border bg-surface p-5 shadow-1"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="settings-tokens" className="text-heading font-semibold">
            Developer: personal access tokens
          </h2>
          <p className="mt-1 text-text-2">
            Tokens let scripts and integrations call the API as you, with{' '}
            <code className="font-mono text-small">Authorization: Bearer</code>. A token never does
            more than you can, only what its scopes allow, in the workspaces and bases you give it.{' '}
            <a href={API_DOCS_PATH} className="text-text underline underline-offset-2">
              API reference
            </a>
          </p>
        </div>
        <Button variant="secondary" className="shrink-0" onClick={() => setCreating(true)}>
          <PlusIcon />
          Create token
        </Button>
      </div>
      <div className="mt-4">
        {list.isPending ? (
          <Skeleton className="h-12" />
        ) : list.isError ? (
          <p className="text-text-2">{message(list.error, "Couldn't load your tokens.")}</p>
        ) : list.data.tokens.length === 0 ? (
          <p className="text-text-2">No tokens yet.</p>
        ) : (
          <ul aria-label="Personal access tokens" className="flex flex-col divide-y divide-border">
            {list.data.tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-2">
                <KeyRoundIcon className="size-4 shrink-0 text-text-2" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-[550] [overflow-wrap:anywhere]">{t.name}</span>
                    <code className="font-mono text-small text-text-2">{t.prefix}…</code>
                    {isExpired(t) && (
                      <span className="rounded-xs border border-border px-1 text-small text-text-2">
                        Expired
                      </span>
                    )}
                  </div>
                  <div className="text-small text-text-2">
                    {t.scopes.join(', ')} · {grantSummary(t)}
                  </div>
                  <div className="text-small text-text-2">
                    {t.lastUsedAt ? `Last used ${day(t.lastUsedAt)}` : 'Never used'} ·{' '}
                    {isExpired(t) ? 'expired' : 'expires'} {day(t.expiresAt)}
                  </div>
                  <TokenUsage token={t} />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revoke.isPending}
                  onClick={() => onRevoke(t)}
                  aria-label={`Revoke ${t.name}`}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {creating && (
        <CreateTokenDialog
          onClose={() => setCreating(false)}
          onCreated={(token) => {
            setCreating(false);
            setCreated(token);
          }}
        />
      )}
      {created && <CreatedTokenDialog token={created} onClose={() => setCreated(null)} />}
    </section>
  );
}

/** The create form: name, scopes, access (whole workspaces or single bases) and expiry. */
function CreateTokenDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (token: CreatedAccessToken) => void;
}) {
  const workspaces = useWorkspaces();
  const create = useCreateAccessToken();
  const [draft, setDraft] = useState<TokenDraft>(emptyDraft);
  const [baseWorkspace] = useState(() => new Map<string, string>());
  const nameId = useId();
  const expiryId = useId();
  const problem = draftProblem(draft);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) {
      toast.error(problem);
      return;
    }
    create.mutate(toRequest(draft, baseWorkspace), {
      onSuccess: onCreated,
      onError: (err) => toast.error(message(err, "Couldn't create the token")),
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Create a personal access token</DialogTitle>
          <DialogDescription>
            It acts as you, limited to these scopes and this access.
          </DialogDescription>
        </DialogHeader>
        <form
          id="create-token"
          onSubmit={onSubmit}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="font-[550]">
              Name
            </label>
            <Input
              id={nameId}
              value={draft.name}
              maxLength={100}
              placeholder="e.g. Nightly sync"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 font-[550]">Scopes</legend>
            {SCOPE_ORDER.map((scope) => (
              <label key={scope} className="flex cursor-pointer items-start gap-2 py-0.5">
                <input
                  type="checkbox"
                  className={`${checkboxClass} mt-0.5`}
                  checked={draft.scopes.includes(scope)}
                  onChange={(e) =>
                    setDraft({ ...draft, scopes: toggle(draft.scopes, scope, e.target.checked) })
                  }
                />
                <span>
                  <code className="font-mono text-small">{scope}</code>
                  <span className="block text-small text-text-2">
                    {TOKEN_SCOPE_DESCRIPTIONS[scope]}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-[550]">Access</legend>
            {workspaces.isPending ? (
              <Skeleton className="h-8" />
            ) : (
              workspaces.data?.workspaces.map((w) => (
                <WorkspaceGrant
                  key={w.id}
                  workspace={w}
                  draft={draft}
                  onChange={setDraft}
                  onBases={(ids) => {
                    for (const id of ids) baseWorkspace.set(id, w.id);
                  }}
                />
              ))
            )}
          </fieldset>
          <div className="flex items-center gap-2">
            <label htmlFor={expiryId} className="font-[550]">
              Expires in
            </label>
            <select
              id={expiryId}
              className={selectClass}
              value={draft.expiresInDays}
              onChange={(e) => setDraft({ ...draft, expiresInDays: Number(e.target.value) })}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-token" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create token'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One workspace in the access list: all of its bases, or some of them. The OAuth consent screen
 * uses it too.
 */
export function WorkspaceGrant({
  workspace,
  draft,
  onChange,
  onBases,
}: {
  workspace: Workspace;
  draft: TokenDraft;
  onChange: (d: TokenDraft) => void;
  onBases: (ids: string[]) => void;
}) {
  const bases = useBases(workspace.id);
  const list = bases.data?.bases;
  useEffect(() => {
    if (list) onBases(list.map((b) => b.id));
  }, [list, onBases]);
  const whole = draft.workspaceIds.includes(workspace.id);
  // A base-only collaborator can grant just their bases.
  const member = workspace.role !== null;
  return (
    <div className="rounded-sm border border-border p-2">
      <label
        className={`flex items-center gap-2 font-[550] ${member ? 'cursor-pointer' : 'opacity-80'}`}
      >
        <input
          type="checkbox"
          className={checkboxClass}
          disabled={!member}
          checked={whole}
          onChange={(e) =>
            onChange({
              ...draft,
              workspaceIds: toggle(draft.workspaceIds, workspace.id, e.target.checked),
            })
          }
        />
        <span className="[overflow-wrap:anywhere]">
          {member ? `All bases in ${workspace.name}` : workspace.name}
        </span>
      </label>
      {list && list.length > 0 && (
        <ul aria-label={`Bases of ${workspace.name}`} className="mt-1 ml-6 flex flex-col">
          {list.map((b) => (
            <li key={b.id}>
              <label className="flex cursor-pointer items-center gap-2 py-0.5">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  disabled={whole}
                  checked={whole || draft.baseIds.includes(b.id)}
                  onChange={(e) =>
                    onChange({ ...draft, baseIds: toggle(draft.baseIds, b.id, e.target.checked) })
                  }
                />
                <span className="[overflow-wrap:anywhere]">{b.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The new token, the only time its secret is shown. */
function CreatedTokenDialog({
  token,
  onClose,
}: {
  token: CreatedAccessToken;
  onClose: () => void;
}) {
  const fieldId = useId();
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(token.token);
      toast.success('Token copied');
    } catch {
      toast.error("Couldn't copy. Select the token and copy it.");
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Copy your new token</DialogTitle>
          <DialogDescription>
            This is the only time "{token.name}" is shown. Store it somewhere safe, like a secret
            manager; if you lose it, revoke it and create another.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <label htmlFor={fieldId} className="sr-only">
            Token
          </label>
          <Input
            id={fieldId}
            readOnly
            value={token.token}
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
