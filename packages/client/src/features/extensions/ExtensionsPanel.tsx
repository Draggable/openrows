import {
  BUILT_IN_EXTENSIONS,
  EXTENSION_LIMITS,
  EXTENSION_SCOPE_LABELS,
  EXTENSION_SIZE_HEIGHTS,
  EXTENSION_SIZES,
  type ExtensionCatalogListing,
  type ExtensionCursor,
  type ExtensionInstallation,
  type ExtensionScope,
  type ExtensionSettings,
  type ExtensionSize,
} from '@openrows/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BookOpenIcon,
  EllipsisIcon,
  PlusIcon,
  PuzzleIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { api } from '../../api/client';
import {
  tableQueries,
  useExtensionBundle,
  useExtensionCatalog,
  useExtensionMutations,
  useExtensions,
  viewQueries,
} from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  toast,
} from '../../components/ui';
import { useTheme } from '../../lib/theme';
import { usePresence } from '../realtime/Presence';
import { useRealtimeChanges, useRealtimeTables } from '../realtime/RealtimeProvider';
import type { HostTable, ScriptApi } from '../scripts/host';
import { cursorOf, extensionBase, type MountedExtension, mountExtension } from './host';
import { parsePackage } from './model';

/** The records API as the signed-in person: what an extension's calls go through. */
const recordsApi: ScriptApi = {
  query: (tableId, body) => api.records.query({ params: { tableId }, body }),
  get: (tableId, recordId) => api.records.get({ params: { tableId, recordId } }),
  create: async (tableId, records) => {
    const res = await api.records.create({ params: { tableId }, body: { records } });
    return 'records' in res ? res.records : [res];
  },
  update: async (tableId, records) =>
    (await api.records.updateMany({ params: { tableId }, body: { records } })).records,
  delete: async (tableId, recordIds) => {
    await api.records.deleteMany({ params: { tableId }, body: { recordIds } });
  },
};

const openUrl = (url: string) => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

/** The tables live updates are followed for (the realtime gateway caps subscriptions). */
const MAX_WATCHED_TABLES = 20;

/** Every table of the base with its fields and views, live through the query cache. */
function useHostTables(baseId: string): HostTable[] {
  const list = useQuery(tableQueries.list(baseId));
  const ids = (list.data?.tables ?? []).map((t) => t.id);
  const details = useQueries({ queries: ids.map((id) => tableQueries.detail(id)) });
  const views = useQueries({ queries: ids.map((id) => viewQueries.list(id)) });
  const key = JSON.stringify([
    details.map((d) => d.dataUpdatedAt),
    views.map((v) => v.dataUpdatedAt),
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when any query updates
  return useMemo(() => {
    const out: HostTable[] = [];
    ids.forEach((id, i) => {
      const d = details[i]?.data;
      if (!d) return;
      out.push({
        id,
        name: d.name,
        description: d.description,
        fields: d.fields,
        views: (views[i]?.data?.views ?? []).map((v) => ({ id: v.id, name: v.name, type: v.type })),
      });
    });
    return out;
  }, [key, ids.join(',')]);
}

/** This tab's cursor: the open table and view, the selected cell's or expanded record. */
function useCursor(tableId: string, viewId: string, expandedRecordId: string | undefined) {
  const presence = usePresence();
  const local = useSyncExternalStore(presence.onLocal, presence.local);
  return useMemo(
    () =>
      cursorOf({
        tableId,
        viewId,
        selectedRecordId: local.recordId,
        selectedFieldId: local.fieldId,
        expandedRecordId: expandedRecordId ?? null,
      }),
    [tableId, viewId, local.recordId, local.fieldId, expandedRecordId]
  );
}

interface PanelContext {
  base: { id: string; name: string };
  tables: HostTable[];
  cursor: ExtensionCursor;
  theme: 'light' | 'dark';
}

/**
 * The base's extension panel: the installed extensions in order, each in its own
 * sandboxed frame (host.ts). Creators add, arrange, resize and remove them; editors change
 * their settings from inside the extension; everyone sees them with their own access.
 */
export function ExtensionsPanel({
  base,
  tableId,
  viewId,
  expandedRecordId,
  onClose,
}: {
  base: { id: string; name: string };
  tableId: string;
  viewId: string;
  expandedRecordId: string | undefined;
  onClose: () => void;
}) {
  const list = useExtensions(base.id);
  const extensions = list.data?.extensions ?? [];
  const canManage = list.data?.canManage === true;
  const tables = useHostTables(base.id);
  const cursor = useCursor(tableId, viewId, expandedRecordId);
  const theme = useTheme().resolved;
  const [adding, setAdding] = useState(false);
  const mounted = useRef(new Map<string, MountedExtension>());
  const { reorder, update, remove } = useExtensionMutations(base.id);

  const reads = extensions.some((e) => e.manifest.scopes.includes('records:read'));
  useRealtimeTables(reads ? tables.slice(0, MAX_WATCHED_TABLES).map((t) => t.id) : []);
  const onChanges = useCallback((tableIds: readonly string[] | null) => {
    for (const m of mounted.current.values()) m.changed(tableIds);
  }, []);
  useRealtimeChanges(onChanges);

  const ctx: PanelContext = { base, tables, cursor, theme };
  const register = useCallback((id: string, m: MountedExtension | null) => {
    if (m) mounted.current.set(id, m);
    else mounted.current.delete(id);
  }, []);

  const move = (id: string, by: -1 | 1) => {
    const ids = extensions.map((e) => e.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
    reorder.mutate(ids, { onError: () => toast.error("Couldn't move the extension.") });
  };

  return (
    <aside
      aria-label="Extensions"
      className="flex w-[380px] shrink-0 flex-col border-l border-border bg-app max-md:fixed max-md:inset-0 max-md:z-40 max-md:w-full"
    >
      <div className="flex h-[44px] shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <PuzzleIcon className="size-4 text-text-2" aria-hidden="true" />
          Extensions
        </h2>
        <div className="flex items-center gap-1">
          {canManage && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAdding(true)}
              disabled={extensions.length >= EXTENSION_LIMITS.maxPerBase}
              aria-haspopup="dialog"
            >
              <PlusIcon />
              Add extension
            </Button>
          )}
          <Button variant="ghost" size="icon" aria-label="Close extensions" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {list.isPending ? (
          <Skeleton className="h-40" />
        ) : list.isError ? (
          <p role="alert" className="text-text-2">
            Couldn't load the extensions.
          </p>
        ) : extensions.length === 0 ? (
          <div className="grid gap-2 py-8 text-center text-text-2">
            <p>No extensions on this base yet.</p>
            {canManage ? (
              <p>Add a chart, a print view or a URL preview, or upload your own.</p>
            ) : (
              <p>Creators can add them.</p>
            )}
          </div>
        ) : (
          extensions.map((ext, i) => (
            <ExtensionCard
              key={ext.id}
              installation={ext}
              ctx={ctx}
              canManage={canManage}
              canConfigure={list.data?.canConfigure === true}
              first={i === 0}
              last={i === extensions.length - 1}
              register={register}
              onMove={(by) => move(ext.id, by)}
              onResize={(size) =>
                update.mutate(
                  { extensionId: ext.id, size },
                  { onError: () => toast.error("Couldn't resize the extension.") }
                )
              }
              onRemove={() =>
                remove.mutate(ext.id, {
                  onSuccess: () => toast.success(`Removed ${ext.name}.`),
                  onError: () => toast.error("Couldn't remove the extension."),
                })
              }
            />
          ))
        )}
      </div>
      {canManage && (
        <AddExtensionDialog
          baseId={base.id}
          open={adding}
          onOpenChange={setAdding}
          canInstallCustom={list.data?.canInstallCustom === true}
          canBrowseCatalog={list.data?.canBrowseCatalog === true}
        />
      )}
    </aside>
  );
}

function ExtensionCard({
  installation,
  ctx,
  canManage,
  canConfigure,
  first,
  last,
  register,
  onMove,
  onResize,
  onRemove,
}: {
  installation: ExtensionInstallation;
  ctx: PanelContext;
  canManage: boolean;
  canConfigure: boolean;
  first: boolean;
  last: boolean;
  register: (id: string, m: MountedExtension | null) => void;
  onMove: (by: -1 | 1) => void;
  onResize: (size: ExtensionSize) => void;
  onRemove: () => void;
}) {
  const bundle = useExtensionBundle(installation.baseId, installation.id);
  const { settings: saveSettings } = useExtensionMutations(installation.baseId);
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);
  const mountedRef = useRef<MountedExtension | null>(null);
  const scopes = installation.manifest.scopes;
  // The latest page state, read when the frame starts and by the call handler.
  const latest = useRef(ctx);
  latest.current = ctx;
  const settingsRef = useRef(installation.settings);
  settingsRef.current = installation.settings;
  const titleId = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: the frame restarts only for a new bundle, scopes or a reload
  useEffect(() => {
    const el = frame.current;
    if (!el || !bundle.data) return;
    setError(null);
    const c = latest.current;
    const m = mountExtension({
      frame: el,
      bundle: bundle.data.bundle,
      init: {
        installation: { id: installation.id, name: installation.name },
        scopes: [...scopes],
        theme: c.theme,
        base: extensionBase(c.base, c.tables, scopes),
        cursor: scopes.includes('cursor:read') ? c.cursor : null,
        settings: settingsRef.current,
        canEditSettings: canConfigure && scopes.includes('settings:write'),
        limits: EXTENSION_LIMITS,
      },
      getTables: () => latest.current.tables,
      deps: {
        api: recordsApi,
        openUrl,
        saveSettings: async (settings: ExtensionSettings) => {
          const saved = await saveSettings.mutateAsync({ extensionId: installation.id, settings });
          return saved.settings;
        },
      },
      onError: setError,
    });
    mountedRef.current = m;
    register(installation.id, m);
    return () => {
      register(installation.id, null);
      mountedRef.current = null;
      m.destroy();
    };
  }, [bundle.data, installation.id, scopes.join(','), run]);

  const settingsKey = JSON.stringify(installation.settings);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pushed when the stored settings change
  useEffect(() => {
    mountedRef.current?.push({ type: 'event', name: 'settings', settings: installation.settings });
  }, [settingsKey]);
  const cursorKey = JSON.stringify(ctx.cursor);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pushed when the cursor moves
  useEffect(() => {
    mountedRef.current?.push({ type: 'event', name: 'cursor', cursor: ctx.cursor });
  }, [cursorKey]);
  useEffect(() => {
    mountedRef.current?.push({ type: 'event', name: 'theme', theme: ctx.theme });
  }, [ctx.theme]);
  const baseKey = JSON.stringify(ctx.tables.map((t) => [t.id, t.name, t.fields, t.views]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: pushed when the schema changes
  useEffect(() => {
    mountedRef.current?.push({
      type: 'event',
      name: 'base',
      base: extensionBase(ctx.base, ctx.tables, scopes),
    });
  }, [baseKey]);

  const height = EXTENSION_SIZE_HEIGHTS[installation.size];
  return (
    <section
      aria-labelledby={titleId}
      className="shrink-0 overflow-hidden rounded-md border border-border bg-surface shadow-1"
      data-testid="extension-card"
    >
      <header className="flex h-9 items-center justify-between gap-2 border-b border-border px-3">
        <h3 id={titleId} className="truncate text-[13px] font-[550]">
          {installation.name}
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`${installation.name} options`}>
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="text-[12px] font-normal text-text-2">
              {scopes.length === 0
                ? 'No access to your data'
                : scopes.map((s) => EXTENSION_SCOPE_LABELS[s]).join('. ')}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setRun((n) => n + 1)}>Reload</DropdownMenuItem>
            {canManage && (
              <>
                <DropdownMenuItem disabled={first} onSelect={() => onMove(-1)}>
                  <ArrowUpIcon />
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={last} onSelect={() => onMove(1)}>
                  <ArrowDownIcon />
                  Move down
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {EXTENSION_SIZES.filter((s) => s !== installation.size).map((s) => (
                  <DropdownMenuItem key={s} onSelect={() => onResize(s)}>
                    {SIZE_LABELS[s]}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-danger" onSelect={onRemove}>
                  <Trash2Icon />
                  Remove
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      {error && (
        <p role="alert" className="border-b border-border px-3 py-2 text-[12px] text-danger">
          {error}
        </p>
      )}
      {bundle.isError ? (
        <p role="alert" className="p-3 text-text-2">
          Couldn't load this extension.
        </p>
      ) : (
        <iframe
          key={run}
          ref={frame}
          title={`${installation.name} extension`}
          className="block w-full border-0 bg-app"
          style={{ height }}
          sandbox="allow-scripts allow-modals"
          referrerPolicy="no-referrer"
        />
      )}
    </section>
  );
}

const SIZE_LABELS: Record<ExtensionSize, string> = {
  small: 'Make small',
  medium: 'Make medium',
  large: 'Make large',
};

function ScopeList({ scopes }: { scopes: readonly ExtensionScope[] }) {
  if (scopes.length === 0) return <p className="text-text-2">No access to your data.</p>;
  return (
    <ul className="list-disc ps-5 text-text-2">
      {scopes.map((s) => (
        <li key={s}>{EXTENSION_SCOPE_LABELS[s]}</li>
      ))}
    </ul>
  );
}

/**
 * The extension catalog: each listing's name, version, publisher, description and the
 * permissions it asks for. **Add** opens the permission prompt; only its confirm sends the
 * install. Browsing installs nothing.
 */
function CatalogBrowser({
  baseId,
  onBack,
  installing,
  onInstall,
}: {
  baseId: string;
  onBack: () => void;
  installing: boolean;
  /** Installs the confirmed listing; `failed` runs if the install is refused. */
  onInstall: (listing: ExtensionCatalogListing, failed: () => void) => void;
}) {
  const catalog = useExtensionCatalog(baseId);
  const [confirming, setConfirming] = useState<ExtensionCatalogListing | null>(null);
  if (confirming) {
    return (
      <CatalogConfirm
        listing={confirming}
        installing={installing}
        onCancel={() => setConfirming(null)}
        onConfirm={() =>
          onInstall(confirming, () => {
            // The listing may have changed (its permissions): show the catalog as it is now.
            setConfirming(null);
            void catalog.refetch();
          })
        }
      />
    );
  }
  return (
    <div className="grid min-h-0 gap-3 overflow-y-auto">
      <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
        <ArrowLeftIcon />
        Back
      </Button>
      {catalog.isPending ? (
        <Skeleton className="h-40" />
      ) : catalog.isError ? (
        <p role="alert" className="text-text-2">
          Couldn't load the catalog.
        </p>
      ) : !catalog.data.available ? (
        <p className="text-text-2">The extension catalog is turned off on this server.</p>
      ) : catalog.data.listings.length === 0 ? (
        <p className="text-text-2">The catalog has no extensions yet.</p>
      ) : (
        <ul className="grid gap-2" aria-label="Catalog listings">
          {catalog.data.listings.map((listing) => (
            <CatalogListing
              key={listing.id}
              listing={listing}
              onAdd={() => setConfirming(listing)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Publisher({ publisher }: { publisher: ExtensionCatalogListing['publisher'] }) {
  return publisher.url ? (
    <a href={publisher.url} target="_blank" rel="noopener noreferrer" className="underline">
      {publisher.name}
    </a>
  ) : (
    publisher.name
  );
}

function CatalogListing({
  listing,
  onAdd,
}: {
  listing: ExtensionCatalogListing;
  onAdd: () => void;
}) {
  return (
    <li
      className="grid gap-1 rounded-md border border-border bg-surface p-3"
      data-testid="catalog-listing"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-[550]">
          {listing.name} <span className="font-normal text-text-2">{listing.version}</span>
        </h3>
        <Button size="sm" aria-label={`Add ${listing.name}`} onClick={onAdd}>
          Add
        </Button>
      </div>
      <p className="text-text-2">
        Published by <Publisher publisher={listing.publisher} />
      </p>
      {listing.description && <p>{listing.description}</p>}
      <p className="text-text-2">Asks to:</p>
      <ScopeList scopes={listing.scopes} />
    </li>
  );
}

/**
 * The permission prompt of a catalog listing, as for an uploaded package: what it asks for,
 * then an explicit confirm. Nothing is sent before **Install**.
 */
function CatalogConfirm({
  listing,
  installing,
  onCancel,
  onConfirm,
}: {
  listing: ExtensionCatalogListing;
  installing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section
      aria-labelledby={titleId}
      className="grid gap-3 rounded-md border border-border bg-surface p-3"
      data-testid="catalog-confirm"
    >
      <h3 id={titleId} ref={heading} tabIndex={-1} className="font-[550] outline-none">
        Add {listing.name} to this base?
      </h3>
      <p>
        <span className="font-[550]">{listing.name}</span>{' '}
        <span className="text-text-2">{listing.version}</span>, published by{' '}
        <Publisher publisher={listing.publisher} />, asks to:
      </p>
      <ScopeList scopes={listing.scopes} />
      <p className="text-text-2">
        It runs in the sandbox with only these permissions. Everyone on the base sees it, each with
        their own access.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={installing} onClick={onConfirm}>
          Install {listing.name}
        </Button>
        <Button variant="outline" disabled={installing} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

function AddExtensionDialog({
  baseId,
  open,
  onOpenChange,
  canInstallCustom,
  canBrowseCatalog,
}: {
  baseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canInstallCustom: boolean;
  canBrowseCatalog: boolean;
}) {
  const { install } = useExtensionMutations(baseId);
  const [upload, setUpload] = useState<ReturnType<typeof parsePackage> | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const fileId = useId();
  useEffect(() => {
    if (!open) {
      setUpload(null);
      setBrowsing(false);
    }
  }, [open]);

  const done = (name: string) => {
    toast.success(`Added ${name}.`);
    onOpenChange(false);
  };
  const onError = (err: Error) => toast.error(err.message || "Couldn't add the extension.");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{browsing ? 'Extension catalog' : 'Add an extension'}</DialogTitle>
          <DialogDescription>
            {browsing
              ? 'Reviewed extensions, with who publishes them and the permissions they ask for. You confirm the permissions before one is added.'
              : 'Extensions run sandboxed, with your access, and only with the permissions they list.'}
          </DialogDescription>
        </DialogHeader>
        {browsing && canBrowseCatalog ? (
          <CatalogBrowser
            baseId={baseId}
            onBack={() => setBrowsing(false)}
            installing={install.isPending}
            onInstall={(listing, failed) =>
              install.mutate(
                { catalog: listing.id, scopes: listing.scopes },
                {
                  onSuccess: () => done(listing.name),
                  onError: (err) => {
                    onError(err);
                    failed();
                  },
                }
              )
            }
          />
        ) : (
          <div className="grid min-h-0 gap-3 overflow-y-auto">
            <ul className="grid gap-2" aria-label="Built-in extensions">
              {BUILT_IN_EXTENSIONS.map((ext) => (
                <li
                  key={ext.key}
                  className="grid gap-1 rounded-md border border-border bg-surface p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-[550]">{ext.manifest.name}</h3>
                    <Button
                      size="sm"
                      disabled={install.isPending}
                      aria-label={`Add ${ext.manifest.name}`}
                      onClick={() =>
                        install.mutate(
                          { builtIn: ext.key },
                          { onSuccess: () => done(ext.manifest.name), onError }
                        )
                      }
                    >
                      Add
                    </Button>
                  </div>
                  <p className="text-text-2">{ext.manifest.description}</p>
                  <ScopeList scopes={ext.manifest.scopes} />
                </li>
              ))}
            </ul>
            {canBrowseCatalog && (
              <div className="grid gap-2 rounded-md border border-border p-3">
                <h3 className="font-[550]">Extension catalog</h3>
                <p className="text-text-2">
                  Browse reviewed extensions and add one: who publishes each one and the permissions
                  it asks for.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setBrowsing(true)}
                >
                  <BookOpenIcon />
                  Browse the catalog
                </Button>
              </div>
            )}
            {canInstallCustom && (
              <div className="grid gap-2 rounded-md border border-border p-3">
                <h3 className="font-[550]">Your own extension</h3>
                <p className="text-text-2">
                  Upload a package (a JSON file with a manifest and a bundle, built with
                  @openrows/blocks). Its code runs in the sandbox, with your access.
                </p>
                <label htmlFor={fileId} className="flex w-fit cursor-pointer items-center gap-2">
                  <UploadIcon className="size-4" aria-hidden="true" />
                  <span className="underline">Choose a package file</span>
                </label>
                <input
                  id={fileId}
                  type="file"
                  accept="application/json,.json"
                  className="text-[12px]"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > EXTENSION_LIMITS.maxBundleChars * 2) {
                      setUpload({ ok: false, error: 'That file is too large (2 MB at most).' });
                      return;
                    }
                    setUpload(parsePackage(await file.text()));
                  }}
                />
                {upload && !upload.ok && (
                  <p role="alert" className="text-danger">
                    {upload.error}
                  </p>
                )}
                {upload?.ok && (
                  <div className="grid gap-2">
                    <p>
                      <span className="font-[550]">{upload.manifest.name}</span>{' '}
                      <span className="text-text-2">{upload.manifest.version}</span> asks to:
                    </p>
                    <ScopeList scopes={upload.manifest.scopes} />
                    <Button
                      className="w-fit"
                      disabled={install.isPending}
                      onClick={() =>
                        install.mutate(
                          { manifest: upload.manifest, bundle: upload.bundle },
                          { onSuccess: () => done(upload.manifest.name), onError }
                        )
                      }
                    >
                      Install {upload.manifest.name}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
