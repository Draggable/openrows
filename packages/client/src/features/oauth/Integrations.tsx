import type { OAuthApp, OAuthAppWithSecret, OAuthAuthorization } from '@openrows/shared';
import { AppWindowIcon, CopyIcon, PlugIcon, PlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  useCreateOAuthApp,
  useDeleteOAuthApp,
  useOAuthApps,
  useOAuthAuthorizations,
  useRevokeOAuthAuthorization,
  useUpdateOAuthApp,
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
import { grantSummary } from '../tokens/model';
import {
  type AppDraft,
  appDraftProblem,
  draftOf,
  emptyAppDraft,
  redirectLines,
  toAppRequest,
} from './model';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

const sectionClass = 'rounded-lg border border-border bg-surface p-5 shadow-1';
const textareaClass =
  'min-h-[72px] w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 font-mono text-small text-text placeholder:text-text-3 hover:border-border-strong';

/**
 * Settings → Integrations: the OAuth apps you authorized, what each may do and where,
 * and revoking one (its tokens stop working at once).
 */
export function AuthorizedApps() {
  const list = useOAuthAuthorizations();
  const revoke = useRevokeOAuthAuthorization();

  const onRevoke = (a: OAuthAuthorization) => {
    if (!window.confirm(`Revoke ${a.app.name}'s access? It stops working right away.`)) return;
    revoke.mutate(a.id, {
      onSuccess: () => toast.success(`${a.app.name} can no longer access your data`),
      onError: (err) => toast.error(message(err, "Couldn't revoke the app's access")),
    });
  };

  return (
    <section aria-labelledby="settings-integrations" className={sectionClass}>
      <h2 id="settings-integrations" className="text-heading font-semibold">
        Integrations
      </h2>
      <p className="mt-1 text-text-2">
        Apps you allowed to use your data through OAuth. Each acts as you, only with the scopes and
        in the workspaces and bases you picked.
      </p>
      <div className="mt-4">
        {list.isPending ? (
          <Skeleton className="h-12" />
        ) : list.isError ? (
          <p className="text-text-2">{message(list.error, "Couldn't load your integrations.")}</p>
        ) : list.data.authorizations.length === 0 ? (
          <p className="text-text-2">No apps have access.</p>
        ) : (
          <ul aria-label="Authorized apps" className="flex flex-col divide-y divide-border">
            {list.data.authorizations.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2">
                <PlugIcon className="size-4 shrink-0 text-text-2" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="font-[550] [overflow-wrap:anywhere]">
                    {a.app.homepageUrl ? (
                      <a
                        href={a.app.homepageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline-offset-2 hover:underline"
                      >
                        {a.app.name}
                      </a>
                    ) : (
                      a.app.name
                    )}
                  </div>
                  <div className="text-small text-text-2">
                    {a.scopes.join(', ')} · {grantSummary(a)}
                  </div>
                  <div className="text-small text-text-2">
                    Authorized {day(a.createdAt)} ·{' '}
                    {a.lastUsedAt ? `last used ${day(a.lastUsedAt)}` : 'never used'}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={revoke.isPending}
                  onClick={() => onRevoke(a)}
                  aria-label={`Revoke ${a.app.name}`}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/**
 * Settings → Developer: OAuth apps: register an app (name, homepage, redirect URIs),
 * see its client id, copy its client secret once, rotate it, change or delete the app.
 */
export function OAuthApps() {
  const list = useOAuthApps();
  const remove = useDeleteOAuthApp();
  const [editing, setEditing] = useState<OAuthApp | 'new' | null>(null);
  const [secret, setSecret] = useState<OAuthAppWithSecret | null>(null);

  const onDelete = (app: OAuthApp) => {
    if (!window.confirm(`Delete ${app.name}? Everyone who authorized it loses it at once.`)) return;
    remove.mutate(app.id, {
      onSuccess: () => toast.success('App deleted'),
      onError: (err) => toast.error(message(err, "Couldn't delete the app")),
    });
  };

  return (
    <section aria-labelledby="settings-oauth-apps" className={sectionClass}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="settings-oauth-apps" className="text-heading font-semibold">
            Developer: OAuth apps
          </h2>
          <p className="mt-1 text-text-2">
            Register an integration so other people can connect it to their workspaces with OAuth
            2.0 (authorization code with PKCE). Its tokens act as the person who allowed it.
          </p>
        </div>
        <Button variant="secondary" className="shrink-0" onClick={() => setEditing('new')}>
          <PlusIcon />
          New app
        </Button>
      </div>
      <div className="mt-4">
        {list.isPending ? (
          <Skeleton className="h-12" />
        ) : list.isError ? (
          <p className="text-text-2">{message(list.error, "Couldn't load your apps.")}</p>
        ) : list.data.apps.length === 0 ? (
          <p className="text-text-2">No apps yet.</p>
        ) : (
          <ul aria-label="OAuth apps" className="flex flex-col divide-y divide-border">
            {list.data.apps.map((app) => (
              <li key={app.id} className="flex items-center gap-3 py-2">
                <AppWindowIcon className="size-4 shrink-0 text-text-2" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="font-[550] [overflow-wrap:anywhere]">{app.name}</div>
                  <code className="font-mono text-small text-text-2">{app.clientId}</code>
                  <div className="text-small text-text-2 [overflow-wrap:anywhere]">
                    {app.redirectUris.join(', ')}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(app)}
                  aria-label={`Edit ${app.name}`}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={remove.isPending}
                  onClick={() => onDelete(app)}
                  aria-label={`Delete ${app.name}`}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {editing && (
        <AppDialog
          app={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSecret={(app) => {
            setEditing(null);
            setSecret(app);
          }}
        />
      )}
      {secret && <SecretDialog app={secret} onClose={() => setSecret(null)} />}
    </section>
  );
}

/** Registers an app, or changes one (and rotates its secret). */
function AppDialog({
  app,
  onClose,
  onSecret,
}: {
  app: OAuthApp | null;
  onClose: () => void;
  onSecret: (app: OAuthAppWithSecret) => void;
}) {
  const create = useCreateOAuthApp();
  const update = useUpdateOAuthApp();
  const [draft, setDraft] = useState<AppDraft>(() => (app ? draftOf(app) : emptyAppDraft()));
  const id = useId();
  const pending = create.isPending || update.isPending;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = appDraftProblem(draft);
    if (problem) {
      toast.error(problem);
      return;
    }
    const body = toAppRequest(draft);
    if (!app) {
      create.mutate(body, {
        onSuccess: onSecret,
        onError: (err) => toast.error(message(err, "Couldn't register the app")),
      });
      return;
    }
    update.mutate(
      { appId: app.id, body },
      {
        onSuccess: () => {
          toast.success('App saved');
          onClose();
        },
        onError: (err) => toast.error(message(err, "Couldn't save the app")),
      }
    );
  };

  const onRotate = () => {
    if (!app) return;
    if (!window.confirm('Make a new client secret? The current one stops working at once.')) return;
    update.mutate(
      { appId: app.id, body: { rotateSecret: true } },
      {
        onSuccess: onSecret,
        onError: (err) => toast.error(message(err, "Couldn't rotate the secret")),
      }
    );
  };

  const field = (key: keyof AppDraft) => ({
    id: `${id}-${key}`,
    value: draft[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft({ ...draft, [key]: e.target.value }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{app ? `Edit ${app.name}` : 'Register an OAuth app'}</DialogTitle>
          <DialogDescription>
            People see its name and homepage when they're asked to allow it.
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          onSubmit={onSubmit}
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-name`} className="font-[550]">
              Name
            </label>
            <Input {...field('name')} maxLength={100} placeholder="e.g. Acme Sync" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-description`} className="font-[550]">
              Description <span className="font-normal text-text-2">(optional)</span>
            </label>
            <Input {...field('description')} maxLength={500} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-homepageUrl`} className="font-[550]">
              Homepage <span className="font-normal text-text-2">(optional)</span>
            </label>
            <Input {...field('homepageUrl')} placeholder="https://" inputMode="url" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-redirectUris`} className="font-[550]">
              Redirect URIs
            </label>
            <textarea
              {...field('redirectUris')}
              rows={3}
              className={textareaClass}
              placeholder="https://example.com/oauth/callback"
              aria-describedby={`${id}-redirect-help`}
            />
            <p id={`${id}-redirect-help`} className="text-small text-text-2">
              One per line, matched exactly. https, or http on localhost.{' '}
              {redirectLines(draft.redirectUris).length > 0 &&
                `${redirectLines(draft.redirectUris).length} URI(s).`}
            </p>
          </div>
          {app && (
            <div className="flex items-center justify-between gap-3 rounded-sm border border-border p-3">
              <div className="min-w-0">
                <div className="font-[550]">Client secret</div>
                <p className="text-small text-text-2">
                  Shown only when it's made. Rotate it if it may have leaked.
                </p>
              </div>
              <Button type="button" variant="outline" disabled={pending} onClick={onRotate}>
                Rotate secret
              </Button>
            </div>
          )}
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={pending}>
            {pending ? 'Saving…' : app ? 'Save' : 'Register app'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The client id and the new secret, the only time the secret is shown. */
function SecretDialog({ app, onClose }: { app: OAuthAppWithSecret; onClose: () => void }) {
  const id = useId();
  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${what} copied`);
    } catch {
      toast.error(`Couldn't copy. Select the ${what.toLowerCase()} and copy it.`);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Copy the client secret</DialogTitle>
          <DialogDescription>
            This is the only time {app.name}'s secret is shown. Keep it on your server, never in a
            browser or mobile app; if you lose it, rotate it.
          </DialogDescription>
        </DialogHeader>
        {[
          { key: 'client-id', label: 'Client ID', value: app.clientId },
          { key: 'client-secret', label: 'Client secret', value: app.clientSecret ?? '' },
        ].map((f) => (
          <div key={f.key} className="flex flex-col gap-1">
            <label htmlFor={`${id}-${f.key}`} className="font-[550]">
              {f.label}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={`${id}-${f.key}`}
                readOnly
                value={f.value}
                className="font-mono text-small"
                onFocus={(e) => e.target.select()}
              />
              <Button
                variant="secondary"
                onClick={() => void copy(f.value, f.label)}
                aria-label={`Copy ${f.label}`}
              >
                <CopyIcon />
                Copy
              </Button>
            </div>
          </div>
        ))}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
