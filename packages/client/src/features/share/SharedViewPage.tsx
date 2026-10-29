import {
  downloads,
  SHARE_PASSWORD_MAX,
  type SharedRecord,
  type SharedShare,
  type SharedView,
} from '@openrows/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { DownloadIcon, ExternalLinkIcon, LockIcon } from 'lucide-react';
import {
  type ClipboardEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, downloadUrl } from '../../api/client';
import { shareQueries, useUnlockShare } from '../../api/queries';
import { BRAND, Logo, MadeWith, Wordmark } from '../../app/Logo';
import { Button, buttonVariants, Input, Skeleton } from '../../components/ui';
import { loginHref } from '../../lib/auth';
import { setThemeOverride } from '../../lib/theme';
import { cn } from '../../lib/utils';
import { GUTTER_WIDTH, gridColumns, HEADER_HEIGHT, rowHeightOf } from '../grid/layout';
import { type EmbedTheme, sharePath } from './model';
import { asFieldMeta, SharedCell } from './SharedCell';
import { SharedLayout } from './SharedLayouts';
import { useTurnstile } from './turnstile';

/** Records per request (the API's largest page is 200). */
const PAGE = 100;

/** Keeps search engines and Referer headers away from the page while it is open. */
export function usePrivatePage(title: string | undefined) {
  useEffect(() => {
    const metas = [
      ['robots', 'noindex, nofollow'],
      ['referrer', 'no-referrer'],
    ].map(([name, content]) => {
      const meta = document.createElement('meta');
      meta.name = name ?? '';
      meta.content = content ?? '';
      document.head.append(meta);
      return meta;
    });
    return () => {
      for (const m of metas) m.remove();
    };
  }, []);
  useEffect(() => {
    if (title) document.title = `${title} · ${BRAND}`;
  }, [title]);
}

/** The views a link opens, flat, with their table's name. */
function viewsOf(share: SharedShare) {
  return share.tables.flatMap((t, table) =>
    t.views.map((v) => ({ ...v, table, tableName: t.name }))
  );
}

/** An embedded link's theme, imposed while the page is open and never stored. */
function useEmbedTheme(theme: EmbedTheme | undefined) {
  useLayoutEffect(() => {
    if (!theme) return;
    setThemeOverride(theme === 'auto' ? 'system' : theme);
    return () => setThemeOverride(null);
  }, [theme]);
}

/**
 * `/s/:token`: a view or a whole base shared with a link, read-only and without an
 * account (unless the link is limited to email domains). The server answers only the views'
 * visible fields and filtered records; this page draws a grid with the view's column order,
 * widths, frozen columns and row height, and a kanban, calendar, gallery, timeline or list
 * read-only with its layout (SharedLayouts.tsx). A base link lists its tables as tabs and the
 * table's views in a picker (the `view` search parameter). A link with a password asks for it
 * first; the server then sets a cookie for this link only.
 *
 * With `embed` it is `/embed/:token`, the variant other sites put in an iframe (only the
 * link's embed origins may: the server's frame-ancestors): a compact bar instead of the header
 * and footer, the `theme` parameter instead of the visitor's setting, and links that leave the
 * frame (sign-in, the full page) open in a new tab.
 */
export function SharedViewPage({
  token,
  viewId,
  onSelectView,
  embed,
}: {
  token: string;
  viewId?: string | undefined;
  onSelectView?: (viewId: string) => void;
  embed?: { theme: EmbedTheme } | undefined;
}) {
  const share = useQuery(shareQueries.share(token));
  usePrivatePage(share.data?.name);
  useEmbedTheme(embed?.theme);
  const [localView, setLocalView] = useState<string | undefined>(undefined);
  const views = share.data ? viewsOf(share.data) : [];
  const wanted = viewId ?? localView;
  const current = views.find((v) => v.id === wanted) ?? views[0];
  const select = (id: string) => {
    setLocalView(id);
    onSelectView?.(id);
  };
  const noCopy = share.data !== undefined && !share.data.allowCopy;
  const block = (e: ClipboardEvent) => {
    if (noCopy) e.preventDefault();
  };
  return (
    <div className="flex h-dvh flex-col bg-app text-text">
      <header
        className={cn(
          'flex shrink-0 items-center gap-3 border-b border-border bg-surface',
          embed ? 'h-9 px-3' : 'h-12 px-4'
        )}
      >
        {!embed && <Logo withWordmark={false} />}
        {share.data ? (
          <h1 className="min-w-0 truncate text-body">
            <span className="font-semibold">{share.data.name}</span>
            {share.data.kind === 'view' && current && (
              <span className="text-text-2"> · {current.tableName}</span>
            )}
          </h1>
        ) : (
          <span className="text-body font-semibold">Shared link</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {share.data?.allowDownload && current && (
            <a
              href={downloadUrl(downloads.sharedCsv, {
                params: { shareToken: token, viewId: current.id },
              })}
              download
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <DownloadIcon aria-hidden />
              Download CSV
            </a>
          )}
          {embed ? (
            <a
              href={sharePath(token)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-small text-text-2 hover:text-text"
            >
              <span>
                View in <Wordmark />
              </span>
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </a>
          ) : (
            <span className="rounded-full border border-border px-2 text-small text-text-2">
              Read-only
            </span>
          )}
        </span>
      </header>
      {share.data?.kind === 'base' && current && (
        <BaseNav share={share.data} current={current} onSelect={select} />
      )}
      <main
        className={cn('flex min-h-0 flex-1 flex-col', noCopy && 'select-none')}
        onCopy={block}
        onCut={block}
      >
        {share.isPending ? (
          <Loading />
        ) : share.data ? (
          current ? (
            <SharedViewBody
              key={current.id}
              token={token}
              viewId={current.id}
              embed={Boolean(embed)}
            />
          ) : (
            <p className="p-6 text-center text-text-2">Nothing is shared in this base yet.</p>
          )
        ) : (
          <Gate token={token} error={share.error} embed={Boolean(embed)} />
        )}
      </main>
      {!embed && <PageFooter />}
    </div>
  );
}

function PageFooter() {
  return (
    <footer className="flex h-9 shrink-0 items-center justify-center border-t border-border bg-surface text-small text-text-2">
      <MadeWith />
    </footer>
  );
}

function Loading() {
  return (
    <div className="grid gap-2 p-4">
      <Skeleton className="h-8" />
      <Skeleton className="h-8" />
      <Skeleton className="h-8" />
    </div>
  );
}

/** A base link's tables as tabs, and the selected table's views in a picker. */
function BaseNav({
  share,
  current,
  onSelect,
}: {
  share: SharedShare;
  current: ReturnType<typeof viewsOf>[number];
  onSelect: (viewId: string) => void;
}) {
  const table = share.tables[current.table];
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <div role="tablist" aria-label="Tables" className="flex min-w-0 gap-1 overflow-x-auto">
        {share.tables.map((t, i) => {
          const first = t.views[0];
          return (
            <button
              // Table names can repeat; their place is their identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: tables have no id here
              key={i}
              type="button"
              role="tab"
              aria-selected={i === current.table}
              disabled={!first}
              onClick={() => first && onSelect(first.id)}
              className={cn(
                'h-7 shrink-0 rounded-sm px-2.5 text-body whitespace-nowrap hover:bg-hover',
                i === current.table ? 'bg-selected font-semibold text-text' : 'text-text-2'
              )}
            >
              {t.name}
            </button>
          );
        })}
      </div>
      {table && table.views.length > 1 && (
        <label className="ml-auto flex shrink-0 items-center gap-2 text-small text-text-2">
          View
          <select
            value={current.id}
            onChange={(e) => onSelect(e.target.value)}
            className="h-7 rounded-sm border border-border bg-surface px-2 text-body text-text"
          >
            {table.views.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function SharedViewBody({
  token,
  viewId,
  embed,
}: {
  token: string;
  viewId: string;
  embed: boolean;
}) {
  const view = useQuery(shareQueries.view(token, viewId));
  if (view.isPending) return <Loading />;
  if (!view.data) return <Gate token={token} error={view.error} embed={embed} />;
  if (view.data.view.type !== 'grid') {
    return <SharedLayout token={token} viewId={viewId} shared={view.data} />;
  }
  return <SharedGrid token={token} viewId={viewId} shared={view.data} embed={embed} />;
}

/**
 * What a link asks before it shows anything: its password, a sign-in, or an account at an
 * allowed domain; else it is gone (or the request failed). Embedded, the sign-in opens in a
 * new tab: the identity provider refuses to be framed, and a sign-in inside another site's page
 * would teach people to type passwords into frames.
 */
function Gate({ token, error, embed }: { token: string; error: unknown; embed: boolean }) {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'SHARE_PASSWORD_REQUIRED') {
    return <PasswordForm token={token} captchaSiteKey={captchaSiteKeyOf(error)} />;
  }
  if (code === 'SHARE_SIGN_IN_REQUIRED') {
    return (
      <Notice title="Sign in to open this link">
        <p className="max-w-sm text-text-2">
          Whoever shared it limited it to people with an email at their organization.
        </p>
        <a
          href={loginHref('login', sharePath(token))}
          className={buttonVariants()}
          {...(embed ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          Sign in to view
        </a>
      </Notice>
    );
  }
  if (code === 'SHARE_DOMAIN_NOT_ALLOWED') {
    return (
      <Notice title="Your account can’t open this link">
        <p className="max-w-sm text-text-2">
          It is limited to people with a verified email at certain domains. Sign in with another
          account, or ask whoever shared it for access.
        </p>
      </Notice>
    );
  }
  return <Unavailable error={error} />;
}

function Unavailable({ error }: { error: unknown }) {
  const gone = error instanceof ApiError && error.status === 404;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <h2 className="text-title font-semibold">
        {gone ? 'This link isn’t available' : 'Couldn’t load this link'}
      </h2>
      <p className="max-w-sm text-text-2">
        {gone
          ? 'It may have been revoked or expired. Ask whoever shared it for a new link.'
          : 'Try again in a moment.'}
      </p>
    </div>
  );
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-title font-semibold">{title}</h2>
      {children}
    </div>
  );
}

/** The Turnstile site key a password prompt's problem names, when the server has one. */
export function captchaSiteKeyOf(err: unknown): string | null {
  if (!(err instanceof ApiError) || typeof err.data !== 'object' || err.data === null) return null;
  const key = (err.data as { captchaSiteKey?: unknown }).captchaSiteKey;
  return typeof key === 'string' && key.length > 0 && key.length <= 200 ? key : null;
}

/**
 * The password of a protected link: the server answers a cookie for this link only. With
 * Turnstile on the server, each attempt also needs a CAPTCHA token.
 */
function PasswordForm({ token, captchaSiteKey }: { token: string; captchaSiteKey: string | null }) {
  const unlock = useUnlockShare(token);
  const captcha = useTurnstile(captchaSiteKey);
  const [password, setPassword] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const err = unlock.error;
  const message = !err
    ? null
    : err instanceof ApiError && err.code === 'SHARE_PASSWORD_INCORRECT'
      ? 'Incorrect password. Try again.'
      : err instanceof ApiError && err.code === 'CAPTCHA_FAILED'
        ? 'The CAPTCHA check failed. Try it again.'
        : err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Try again in a few minutes.'
          : err instanceof ApiError && err.status === 404
            ? 'This link isn’t available any more.'
            : 'Couldn’t check the password. Try again.';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password || (captchaSiteKey && !captcha.token)) return;
    unlock.mutate(
      { password, ...(captcha.token ? { captchaToken: captcha.token } : {}) },
      {
        onError: () => {
          // A token is good for one check: every attempt gets a new one.
          captcha.reset();
          input.current?.select();
        },
      }
    );
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <form
        onSubmit={submit}
        aria-labelledby="share-password-title"
        className="grid w-full max-w-xs gap-3 rounded-md border border-border bg-surface p-5"
      >
        <LockIcon aria-hidden className="size-5 text-text-2" />
        <h2 id="share-password-title" className="text-title font-semibold">
          This link is password protected
        </h2>
        <div className="grid gap-1">
          <label htmlFor="share-password" className="text-small text-text-2">
            Password
          </label>
          <Input
            ref={input}
            id="share-password"
            type="password"
            autoComplete="current-password"
            maxLength={SHARE_PASSWORD_MAX}
            value={password}
            aria-invalid={message !== null}
            aria-describedby={message ? 'share-password-error' : undefined}
            onChange={(e) => setPassword(e.target.value)}
          />
          {message && (
            <p id="share-password-error" role="alert" className="text-small text-danger">
              {message}
            </p>
          )}
        </div>
        {captchaSiteKey && <div ref={captcha.ref} data-testid="share-captcha" />}
        <Button
          type="submit"
          disabled={unlock.isPending || !password || (captchaSiteKey !== null && !captcha.token)}
        >
          Open
        </Button>
      </form>
    </div>
  );
}

function SharedGrid({
  token,
  viewId,
  shared,
  embed,
}: {
  token: string;
  viewId: string;
  shared: SharedView;
  embed: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const fields = useMemo(() => shared.fields.map(asFieldMeta), [shared.fields]);
  const columns = useMemo(() => gridColumns(fields, shared.layout), [fields, shared.layout]);
  const rowHeight = rowHeightOf(shared.layout);
  const first = useQuery(shareQueries.records(token, viewId, 0, PAGE));
  const total = first.data?.total ?? 0;
  const rows = useVirtualizer({
    count: total,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    // Until the first measure (and in tests, where nothing is measured).
    initialRect: { width: 1024, height: 768 },
  });
  const items = rows.getVirtualItems();
  const startPage = Math.floor((items[0]?.index ?? 0) / PAGE);
  const endPage = Math.floor((items.at(-1)?.index ?? 0) / PAGE);
  const pageNumbers = Array.from(
    { length: Math.max(0, endPage - startPage + 1) },
    (_, i) => startPage + i
  );
  const pages = useQueries({
    queries: pageNumbers.map((p) => shareQueries.records(token, viewId, p * PAGE, PAGE)),
  });
  const byIndex = new Map<number, SharedRecord>();
  for (const page of [first.data, ...pages.map((q) => q.data)]) {
    page?.records.forEach((r, i) => {
      byIndex.set(page.offset + i, r);
    });
  }

  const frozenWidth = columns.filter((c) => c.frozen).reduce((w, c) => w + c.width, 0);
  const width = GUTTER_WIDTH + columns.reduce((w, c) => w + c.width, 0);
  const style = (c: (typeof columns)[number]) =>
    c.frozen ? { width: c.width, left: c.left, position: 'sticky' as const } : { width: c.width };

  if (first.isError) return <Gate token={token} error={first.error} embed={embed} />;
  return (
    <>
      <div
        ref={scroller}
        role="table"
        aria-label={shared.view.name}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling; cells take no focus
        tabIndex={0}
        aria-rowcount={total + 1}
        aria-colcount={columns.length}
        className="min-h-0 flex-1 overflow-auto bg-surface"
      >
        <div style={{ width, minWidth: '100%' }}>
          <div
            role="row"
            aria-rowindex={1}
            className="sticky top-0 z-20 flex border-b border-border bg-header"
            style={{ height: HEADER_HEIGHT }}
          >
            <div
              aria-hidden
              className="sticky left-0 z-10 shrink-0 bg-header"
              style={{ width: GUTTER_WIDTH }}
            />
            {columns.map((c, i) => (
              <div
                key={c.field.id}
                role="columnheader"
                aria-colindex={i + 1}
                className={cn(
                  'flex shrink-0 items-center border-r border-border px-2 text-small font-semibold text-text-2',
                  c.frozen && 'z-10 bg-header'
                )}
                style={style(c)}
              >
                <span className="truncate">{c.field.name}</span>
              </div>
            ))}
          </div>
          <div role="rowgroup" className="relative" style={{ height: rows.getTotalSize() }}>
            {items.map((item) => {
              const record = byIndex.get(item.index);
              return (
                <div
                  key={item.key}
                  role="row"
                  aria-rowindex={item.index + 2}
                  className="absolute left-0 flex border-b border-border bg-surface"
                  style={{ top: item.start, height: rowHeight, width }}
                >
                  <div
                    aria-hidden
                    className="sticky left-0 z-10 flex shrink-0 items-center justify-end bg-surface pr-3 text-small text-text-3 tabular-nums"
                    style={{ width: GUTTER_WIDTH }}
                  >
                    {item.index + 1}
                  </div>
                  {columns.map((c, i) => (
                    <div
                      key={c.field.id}
                      role="cell"
                      aria-colindex={i + 1}
                      className={cn(
                        'flex shrink-0 items-center overflow-hidden border-r border-border px-2',
                        c.align === 'right' && 'justify-end tabular-nums',
                        c.align === 'center' && 'justify-center',
                        c.frozen && 'z-[5] bg-surface',
                        c.field.isPrimary && 'font-[550]'
                      )}
                      style={style(c)}
                    >
                      {record ? (
                        <SharedCell
                          token={token}
                          viewId={viewId}
                          field={c.field}
                          value={record.fields[c.field.id] ?? null}
                        />
                      ) : (
                        <Skeleton className="h-3 w-2/3" />
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {first.isSuccess && total === 0 && (
            <p
              className="sticky left-0 p-6 text-center text-text-2"
              style={{ width: `max(100%, ${frozenWidth}px)` }}
            >
              No records in this view.
            </p>
          )}
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center border-t border-border bg-header px-4 text-small text-text-2">
        {first.isSuccess && `${total.toLocaleString()} record${total === 1 ? '' : 's'}`}
      </div>
    </>
  );
}
