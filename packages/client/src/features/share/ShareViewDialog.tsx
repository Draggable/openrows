import {
  SHARE_PASSWORD_MAX,
  SHARE_PASSWORD_MIN,
  type Share,
  type ViewMeta,
} from '@openrows/shared';
import { CheckIcon, CopyIcon, LinkIcon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  type ShareTarget,
  useCreateShare,
  useRevokeShare,
  useShares,
  useUpdateShare,
} from '../../api/queries';
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
import {
  EMBED_THEMES,
  type EmbedTheme,
  embedSnippet,
  embedUrl,
  expiryOf,
  parseDomains,
  parseEmbedOrigins,
  shareBadges,
  shareSummary,
  shareUrl,
  today,
} from './model';

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/**
 * The view menu's "Share view": make a read-only link of the view, copy it (shown once:
 * the server keeps only its hash), change its settings and revoke links. Creators and
 * owners.
 */
export function ShareViewDialog({
  view,
  open,
  onOpenChange,
}: {
  view: ViewMeta;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Remounting the panel on close forgets the link shown once.
  const [round, setRound] = useState(0);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRound((r) => r + 1);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Share {view.name}</DialogTitle>
          <DialogDescription>
            Anyone with the link can see this view's records and visible fields, read-only. Hidden
            fields and other views stay private. Add a password or limit it to email domains.
          </DialogDescription>
        </DialogHeader>
        <ShareLinks
          key={round}
          target={{ kind: 'view', viewId: view.id }}
          open={open}
          name={view.name}
        />
      </DialogContent>
    </Dialog>
  );
}

/** What the create and edit forms hold. */
interface LinkSettings {
  password: string;
  removePassword: boolean;
  domains: string;
  allowCopy: boolean;
  allowDownload: boolean;
  /** Sites that may embed the link, as typed. */
  embedOrigins: string;
  allowRestrictedEmbed: boolean;
}

const NEW_LINK: LinkSettings = {
  password: '',
  removePassword: false,
  domains: '',
  allowCopy: true,
  allowDownload: false,
  embedOrigins: '',
  allowRestrictedEmbed: false,
};

/** The body of a create or update request. */
interface LinkBody {
  password?: string | null;
  allowedDomains: string[];
  allowCopy: boolean;
  allowDownload: boolean;
  embedOrigins: string[];
  allowRestrictedEmbed: boolean;
}

/** The settings as a request body, or the first problem with them. */
function bodyOf(
  s: LinkSettings,
  editing: boolean
): { body: LinkBody; error: null } | { body: null; error: string } {
  const domains = parseDomains(s.domains);
  if (domains.error !== null) return { body: null, error: domains.error };
  const embeds = parseEmbedOrigins(s.embedOrigins);
  if (embeds.error !== null) return { body: null, error: embeds.error };
  const body: LinkBody = {
    allowedDomains: domains.domains,
    allowCopy: s.allowCopy,
    allowDownload: s.allowDownload,
    embedOrigins: embeds.origins,
    allowRestrictedEmbed: s.allowRestrictedEmbed,
  };
  if (s.removePassword) body.password = null;
  else if (s.password) {
    if (s.password.length < SHARE_PASSWORD_MIN) {
      return { body: null, error: `The password needs at least ${SHARE_PASSWORD_MIN} characters.` };
    }
    body.password = s.password;
  } else if (!editing) body.password = null;
  return { body, error: null };
}

/**
 * A view's or a whole base's links: the create form (expiry, password, allowed
 * email domains, copy and download toggles, sites that may embed it), the link just made with its
 * embed code, and the live links with their settings and Revoke. Used by the Share view dialog
 * and the base's Share dialog; `name` titles the embed code's iframe.
 */
export function ShareLinks({
  target,
  open,
  name,
}: {
  target: ShareTarget;
  open: boolean;
  name: string;
}) {
  const id = useId();
  const shares = useShares(target, open);
  const create = useCreateShare(target);
  const [expiry, setExpiry] = useState('');
  const [settings, setSettings] = useState<LinkSettings>(NEW_LINK);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; token: string; embeds: boolean } | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = bodyOf(settings, false);
    if (parsed.error !== null) {
      setError(parsed.error);
      return;
    }
    setError(null);
    create.mutate(
      { expiresAt: expiryOf(expiry), ...parsed.body },
      {
        onSuccess: ({ share, token }) => {
          setMade({ id: share.id, token, embeds: share.embedOrigins.length > 0 });
          setExpiry('');
          setSettings(NEW_LINK);
        },
        onError: (err) => toast.error(errorText(err, "Couldn't create the link.")),
      }
    );
  };

  return (
    <div className="grid gap-4">
      <form onSubmit={submit} className="grid gap-3" aria-label="New share link">
        <div className="grid gap-1">
          <label htmlFor={`${id}-expiry`} className="text-small text-text-2">
            Expires (optional)
          </label>
          <Input
            id={`${id}-expiry`}
            type="date"
            value={expiry}
            min={today()}
            onChange={(e) => setExpiry(e.target.value)}
            className="w-44"
          />
        </div>
        <SettingsFields id={id} settings={settings} onChange={setSettings} hasPassword={false} />
        {error && (
          <p role="alert" className="text-small text-danger">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={create.isPending}>
            <LinkIcon />
            Create link
          </Button>
        </div>
      </form>

      {made && <NewLink id={id} token={made.token} embeds={made.embeds} name={name} />}

      <section aria-labelledby={`${id}-links`} className="grid gap-1">
        <h3 id={`${id}-links`} className="text-small font-semibold text-text-2">
          Active links
        </h3>
        {shares.isPending ? (
          <Skeleton className="h-8" />
        ) : shares.data?.shares.length ? (
          <ul aria-label="Share links" className="grid">
            {shares.data.shares.map((s) => (
              <ShareRow
                key={s.id}
                share={s}
                target={target}
                isNew={s.id === made?.id}
                onRevoked={() => {
                  if (s.id === made?.id) setMade(null);
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="text-small text-text-2">No links yet.</p>
        )}
      </section>
    </div>
  );
}

/** Password, allowed domains and the two toggles: the create form's and a link's edit form. */
function SettingsFields({
  id,
  settings,
  onChange,
  hasPassword,
}: {
  id: string;
  settings: LinkSettings;
  onChange: (s: LinkSettings) => void;
  hasPassword: boolean;
}) {
  const set = (patch: Partial<LinkSettings>) => onChange({ ...settings, ...patch });
  const restricted =
    settings.domains.trim() !== '' ||
    (settings.password !== '' && !settings.removePassword) ||
    (hasPassword && !settings.removePassword);
  return (
    <>
      <div className="grid gap-1">
        <label htmlFor={`${id}-password`} className="text-small text-text-2">
          {hasPassword ? 'New password (leave empty to keep it)' : 'Password (optional)'}
        </label>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          maxLength={SHARE_PASSWORD_MAX}
          value={settings.password}
          disabled={settings.removePassword}
          onChange={(e) => set({ password: e.target.value })}
        />
        {hasPassword && (
          <Toggle
            label="Remove the password"
            checked={settings.removePassword}
            onChange={(removePassword) => set({ removePassword, password: '' })}
          />
        )}
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-domains`} className="text-small text-text-2">
          Only people signed in with an email at (optional)
        </label>
        <Input
          id={`${id}-domains`}
          placeholder="example.com, example.org"
          value={settings.domains}
          onChange={(e) => set({ domains: e.target.value })}
        />
      </div>
      <Toggle
        label="Allow copying data out"
        checked={settings.allowCopy}
        onChange={(allowCopy) => set({ allowCopy })}
      />
      <Toggle
        label="Allow CSV download"
        checked={settings.allowDownload}
        onChange={(allowDownload) => set({ allowDownload })}
      />
      <div className="grid gap-1">
        <label htmlFor={`${id}-embeds`} className="text-small text-text-2">
          Sites that may embed it (optional)
        </label>
        <Input
          id={`${id}-embeds`}
          placeholder="https://intranet.example.com"
          value={settings.embedOrigins}
          onChange={(e) => set({ embedOrigins: e.target.value })}
          aria-describedby={`${id}-embeds-hint`}
        />
        <p id={`${id}-embeds-hint`} className="text-small text-text-2">
          Pages on these https sites can show the link in an iframe. Every other site is refused.
        </p>
        {restricted && settings.embedOrigins.trim() !== '' && (
          <>
            <Toggle
              label="Allow embedding even with a password or email domains"
              checked={settings.allowRestrictedEmbed}
              onChange={(allowRestrictedEmbed) => set({ allowRestrictedEmbed })}
            />
            {!settings.allowRestrictedEmbed && (
              <p className="text-small text-text-2">
                Links with a password or email domains aren't embedded unless you allow it: asking
                for a password or a sign-in inside another site's page invites phishing, and many
                browsers block the cookies it needs in a frame.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-text">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--accent)]"
      />
      <span>{label}</span>
    </label>
  );
}

/** Copies `text`, with a toast either way; answers whether it worked. */
async function copyText(text: string, what: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
    return true;
  } catch {
    toast.error(`Couldn't copy. Select the ${what.toLowerCase()} and copy it.`);
    return false;
  }
}

/** The link just made, with Copy and its embed code: the only time it is shown. */
function NewLink({
  id,
  token,
  embeds,
  name,
}: {
  id: string;
  token: string;
  embeds: boolean;
  name: string;
}) {
  const url = shareUrl(token);
  const [copied, setCopied] = useState(false);
  const copy = async () => setCopied(await copyText(url, 'Link'));
  return (
    <div className="grid gap-1 rounded-md border border-border bg-header p-3">
      <label htmlFor={`${id}-new-link`} className="text-small font-semibold text-text-2">
        New link (copy it now: it won't be shown again)
      </label>
      <div className="flex gap-2">
        <Input
          id={`${id}-new-link`}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 font-mono text-[12px]"
        />
        <Button type="button" variant="outline" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <EmbedCode id={id} token={token} embeds={embeds} name={name} />
    </div>
  );
}

const THEME_LABELS: Record<EmbedTheme, string> = {
  light: 'Light',
  dark: 'Dark',
  auto: 'Match the visitor',
};

/**
 * The iframe snippet of a new link, with its theme. It works only on the link's embed
 * sites, which can be added later in its settings (the code stays the same).
 */
function EmbedCode({
  id,
  token,
  embeds,
  name,
}: {
  id: string;
  token: string;
  embeds: boolean;
  name: string;
}) {
  const [theme, setTheme] = useState<EmbedTheme>('light');
  const code = embedSnippet(embedUrl(token, theme), name);
  return (
    <div className="mt-2 grid gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-embed-code`} className="text-small font-semibold text-text-2">
          Embed code
        </label>
        <label className="ml-auto flex items-center gap-2 text-small text-text-2">
          Theme
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as EmbedTheme)}
            className="h-7 rounded-sm border border-border bg-surface px-2 text-body text-text"
          >
            {EMBED_THEMES.map((t) => (
              <option key={t} value={t}>
                {THEME_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-start gap-2">
        <textarea
          id={`${id}-embed-code`}
          readOnly
          rows={3}
          value={code}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 resize-none rounded-sm border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] text-text"
        />
        <Button type="button" variant="outline" onClick={() => void copyText(code, 'Embed code')}>
          <CopyIcon />
          Copy code
        </Button>
      </div>
      {!embeds && (
        <p className="text-small text-text-2">
          Add the site under the link's Settings first: no site may embed it yet.
        </p>
      )}
    </div>
  );
}

function ShareRow({
  share,
  target,
  isNew,
  onRevoked,
}: {
  share: Share;
  target: ShareTarget;
  isNew: boolean;
  onRevoked: () => void;
}) {
  const id = useId();
  const revoke = useRevokeShare(target);
  const update = useUpdateShare(target);
  const [editing, setEditing] = useState<LinkSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const parsed = bodyOf(editing, true);
    if (parsed.error !== null) {
      setError(parsed.error);
      return;
    }
    setError(null);
    update.mutate(
      { shareId: share.id, body: parsed.body },
      {
        onSuccess: () => {
          setEditing(null);
          toast.success('Link updated');
        },
        onError: (err) => toast.error(errorText(err, "Couldn't update the link.")),
      }
    );
  };

  return (
    <li className="grid gap-2 border-t border-border py-1.5">
      <div className="flex min-h-[36px] items-center gap-3">
        <LinkIcon aria-hidden className="size-4 shrink-0 text-text-2" />
        <span className="grid min-w-0 flex-1">
          <span className="truncate">
            {shareSummary(share)}
            {isNew && <span className="text-text-2"> (new)</span>}
          </span>
          <span className="truncate text-small text-text-2">{shareBadges(share).join(' · ')}</span>
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={editing !== null}
          onClick={() =>
            setEditing((cur) =>
              cur
                ? null
                : {
                    password: '',
                    removePassword: false,
                    domains: share.allowedDomains.join(', '),
                    allowCopy: share.allowCopy,
                    allowDownload: share.allowDownload,
                    embedOrigins: share.embedOrigins.join(', '),
                    allowRestrictedEmbed: share.allowRestrictedEmbed,
                  }
            )
          }
        >
          Settings
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={revoke.isPending}
          onClick={() =>
            revoke.mutate(share.id, {
              onSuccess: () => {
                onRevoked();
                toast.success('Link revoked');
              },
              onError: (err) => toast.error(errorText(err, "Couldn't revoke the link.")),
            })
          }
        >
          Revoke
        </Button>
      </div>
      {editing && (
        <form
          onSubmit={save}
          aria-label="Link settings"
          className="grid gap-3 rounded-md border border-border p-3"
        >
          <SettingsFields
            id={id}
            settings={editing}
            onChange={setEditing}
            hasPassword={share.hasPassword}
          />
          {error && (
            <p role="alert" className="text-small text-danger">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={update.isPending}>
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
