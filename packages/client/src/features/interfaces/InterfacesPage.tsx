import {
  type FieldMeta,
  INTERFACE_LAYOUTS,
  type Interface,
  type InterfaceElement,
  type InterfaceElementType,
  type InterfaceLayout,
  type InterfacePage,
  type InterfacePageConfig,
  interfacePageConfigSchema,
  MAX_DATA_ELEMENTS,
  MAX_FILTER_ELEMENTS,
  MAX_INTERFACE_LIST_FIELDS,
  type MeResponse,
  type RecordData,
  type TableMeta,
} from '@openrows/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftIcon,
  EyeIcon,
  LayoutDashboardIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { baseQueries, tableQueries, useInterfaceMutations, useInterfaces } from '../../api/queries';
import { AccountRow, CommandHint, NavItem, SectionLabel, Shell, TopBar } from '../../app/Shell';
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
import { cn } from '../../lib/utils';
import { CollaboratorsProvider } from '../collaborators/context';
import { cellText } from '../grid/cells/model';
import { FilterMenu } from '../views/toolbar/FilterMenu';
import { SortMenu } from '../views/toolbar/SortMenu';
import { Canvas, type ElementContext } from './Canvas';
import { DataElementSettings } from './DataElementSettings';
import { LayoutSettings } from './LayoutSettings';
import {
  automationButtons,
  ELEMENT_LABELS,
  elementConditions,
  elementTypesFor,
  type FilterValues,
  filterableFields,
  isDataElement,
  LAYOUT_DESCRIPTIONS,
  LAYOUT_LABELS,
  newElement,
  pageFieldIds,
  publishState,
  visibleConfig,
} from './model';
import { PageRuntime } from './PageRuntime';
import { ShareInterfaceDialog } from './ShareInterfaceDialog';
import { type PageSource, useDashboardData } from './useDashboardData';

/** Records a page lists (the first ones, in the page's order). */
const PAGE_RECORDS = 200;

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

const problem = (err: unknown, fallback: string) => {
  if (!(err instanceof ApiError)) return fallback;
  const first = (err.data as { errors?: { path: string; message: string }[] } | undefined)
    ?.errors?.[0];
  return first ? `${err.message} ${first.path}: ${first.message}` : err.message;
};

/** Each open designer's pending draft save, by page: Publish waits for it first. */
const pendingSaves = new Map<string, () => Promise<void>>();

/**
 * `/b/:baseId/interfaces?p=<pageId>&edit=true`: a base's interfaces. Everyone on the base
 * sees the published pages; creators and owners also see drafts and never-published pages, edit
 * them (the designer: elements on a grid, the page's table, columns, filter and sorts) and
 * publish them.
 */
export function InterfacesPage({
  me,
  baseId,
  pageId,
  edit,
}: {
  me: MeResponse;
  baseId: string;
  pageId?: string | undefined;
  edit?: boolean | undefined;
}) {
  const base = useQuery(baseQueries.detail(baseId));
  const list = useInterfaces(baseId);
  const tables = useQuery(tableQueries.list(baseId));
  const navigate = useNavigate();
  const m = useInterfaceMutations(baseId);
  const canEdit = list.data?.canEdit ?? false;
  const interfaces = list.data?.interfaces ?? [];
  const [creating, setCreating] = useState<{ interfaceId: string | null } | null>(null);

  const found = interfaces.flatMap((i) => i.pages.map((p) => ({ iface: i, page: p })));
  // No page asked for: the first one.
  const current = pageId ? found.find((f) => f.page.id === pageId) : found[0];
  const shownPageId = current?.page.id;

  const go = (p: string, editing = false) =>
    navigate({
      to: '/b/$baseId/interfaces',
      params: { baseId },
      search: editing ? { p, edit: true } : { p },
    });

  return (
    <CollaboratorsProvider workspaceId={base.data?.workspaceId} meId={me.user.id}>
      <Shell
        sidebar={
          <div className="flex h-full min-h-0 flex-col">
            <div className="px-3 pt-3">
              <Link
                to="/b/$baseId"
                params={{ baseId }}
                className="flex h-8 items-center gap-2 rounded-sm px-2 text-text-2 hover:bg-hover hover:text-text"
              >
                <ArrowLeftIcon className="size-4" aria-hidden />
                <span className="truncate">{base.data?.name ?? 'Back to the base'}</span>
              </Link>
            </div>
            <SectionLabel
              action={
                canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="New interface"
                    onClick={() => setCreating({ interfaceId: null })}
                  >
                    <PlusIcon />
                  </Button>
                ) : undefined
              }
            >
              Interfaces
            </SectionLabel>
            <nav aria-label="Interfaces" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {interfaces.map((iface) => (
                <InterfaceNav
                  key={iface.id}
                  iface={iface}
                  baseId={baseId}
                  pageId={shownPageId}
                  canEdit={canEdit}
                  onAddPage={() => setCreating({ interfaceId: iface.id })}
                  onDelete={() => {
                    if (!window.confirm(`Delete the interface "${iface.name}" and its pages?`)) {
                      return;
                    }
                    m.remove.mutate(iface.id, {
                      onSuccess: () =>
                        navigate({ to: '/b/$baseId/interfaces', params: { baseId }, search: {} }),
                      onError: (err) => toast.error(problem(err, "Couldn't delete it")),
                    });
                  }}
                />
              ))}
            </nav>
            <div className="mt-auto pt-2">
              <CommandHint />
              <AccountRow me={me} />
            </div>
          </div>
        }
      >
        <TopBar
          actions={
            current && canEdit ? (
              <PageActions
                baseId={baseId}
                iface={current.iface}
                page={current.page}
                edit={!!edit}
                onMode={(e) => go(current.page.id, e)}
                onDeleted={() =>
                  navigate({ to: '/b/$baseId/interfaces', params: { baseId }, search: {} })
                }
              />
            ) : undefined
          }
        >
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[15px]">
            <Link
              to="/b/$baseId"
              params={{ baseId }}
              className="truncate text-text-2 hover:text-text max-sm:hidden"
            >
              {base.data?.name ?? <Skeleton className="h-4 w-24" />}
            </Link>
            <span className="text-text-3 max-sm:hidden">/</span>
            {current ? (
              <>
                <span className="truncate text-text-2">{current.iface.name}</span>
                <span className="text-text-3">/</span>
                <h1 className="truncate font-[550]" aria-current="page">
                  {current.page.name}
                </h1>
              </>
            ) : (
              <h1 className="truncate font-[550]" aria-current="page">
                Interfaces
              </h1>
            )}
          </nav>
        </TopBar>
        <main className="min-h-0 flex-1 overflow-hidden">
          {list.isPending || base.isPending ? (
            <div className="grid gap-2 p-6" aria-busy="true">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : list.isError ? (
            <p className="p-6 text-text-2">
              {problem(list.error, "Couldn't load the interfaces.")}
            </p>
          ) : current ? (
            <PageBody
              key={current.page.id}
              baseId={baseId}
              iface={current.iface}
              page={current.page}
              canEdit={canEdit}
              edit={canEdit && !!edit}
              userRole={base.data?.role ?? undefined}
            />
          ) : pageId && found.length > 0 ? (
            <p className="p-6 text-text-2">This page doesn't exist or isn't published.</p>
          ) : (
            <div className="flex flex-col items-start gap-3 p-6">
              <LayoutDashboardIcon className="size-6 text-text-3" aria-hidden />
              <p className="text-text-2">
                {canEdit
                  ? 'Interfaces are pages built on this base: lists, filters and record reviews for the people you share it with.'
                  : 'No interfaces have been published in this base yet.'}
              </p>
              {canEdit && (
                <Button onClick={() => setCreating({ interfaceId: null })}>
                  <PlusIcon />
                  New interface
                </Button>
              )}
            </div>
          )}
        </main>
        {creating && (
          <NewPageDialog
            interfaceName={
              creating.interfaceId
                ? (interfaces.find((i) => i.id === creating.interfaceId)?.name ?? null)
                : null
            }
            tables={tables.data?.tables ?? []}
            onClose={() => setCreating(null)}
            onCreate={async ({ interfaceName, name, layout, tableId }) => {
              try {
                const interfaceId =
                  creating.interfaceId ?? (await m.create.mutateAsync(interfaceName)).id;
                const page = await m.createPage.mutateAsync({ interfaceId, name, layout, tableId });
                setCreating(null);
                await go(page.id, true);
              } catch (err) {
                toast.error(problem(err, "Couldn't create the page"));
              }
            }}
          />
        )}
      </Shell>
    </CollaboratorsProvider>
  );
}

function InterfaceNav({
  iface,
  baseId,
  pageId,
  canEdit,
  onAddPage,
  onDelete,
}: {
  iface: Interface;
  baseId: string;
  pageId: string | undefined;
  canEdit: boolean;
  onAddPage: () => void;
  onDelete: () => void;
}) {
  return (
    <section aria-label={iface.name} className="mb-1">
      <div className="group flex h-8 items-center gap-1 px-4">
        <h3 className="min-w-0 flex-1 truncate text-small font-[550] text-text-2">{iface.name}</h3>
        {canEdit && (
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`New page in ${iface.name}`}
              onClick={onAddPage}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${iface.name}`}
              onClick={onDelete}
            >
              <Trash2Icon />
            </Button>
          </>
        )}
      </div>
      {iface.pages.map((p) => (
        <NavItem
          key={p.id}
          to="/b/$baseId/interfaces"
          params={{ baseId }}
          search={{ p: p.id }}
          active={p.id === pageId}
          icon={<LayoutDashboardIcon />}
        >
          <span className="min-w-0 flex-1 truncate">{p.name}</span>
          {canEdit && p.published === null && <span className="text-small text-text-3">Draft</span>}
        </NavItem>
      ))}
    </section>
  );
}

function NewPageDialog({
  interfaceName,
  tables,
  onClose,
  onCreate,
}: {
  /** The interface the page goes in; null: a new interface. */
  interfaceName: string | null;
  tables: { id: string; name: string }[];
  onClose: () => void;
  onCreate: (input: {
    interfaceName: string;
    name: string;
    layout: InterfaceLayout;
    tableId: string;
  }) => Promise<void>;
}) {
  const ids = { iface: useId(), name: useId(), table: useId() };
  const [ifaceName, setIfaceName] = useState('My interface');
  const [name, setName] = useState('Review');
  const [layout, setLayout] = useState<InterfaceLayout>('recordReview');
  const [tableId, setTableId] = useState(tables[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const table = tableId || tables[0]?.id || '';
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await onCreate({
              interfaceName: ifaceName.trim(),
              name: name.trim(),
              layout,
              tableId: table,
            });
            setBusy(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {interfaceName ? `New page in ${interfaceName}` : 'New interface'}
            </DialogTitle>
            <DialogDescription>
              Pages start unpublished: only the base's creators and owners see them until you
              publish.
            </DialogDescription>
          </DialogHeader>
          {!interfaceName && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.iface} className="text-small text-text-2">
                Interface name
              </label>
              <Input
                id={ids.iface}
                value={ifaceName}
                maxLength={100}
                onChange={(e) => setIfaceName(e.target.value)}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.name} className="text-small text-text-2">
              Page name
            </label>
            <Input
              id={ids.name}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-small text-text-2">Layout</legend>
            {INTERFACE_LAYOUTS.map((l) => (
              <label
                key={l}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-sm border p-2',
                  layout === l ? 'border-primary bg-selected' : 'border-border hover:bg-hover'
                )}
              >
                <input
                  type="radio"
                  name="layout"
                  value={l}
                  checked={layout === l}
                  onChange={() => setLayout(l)}
                  className="mt-0.5 size-4 accent-[var(--accent)]"
                />
                <span>
                  <span className="block font-[550] text-text">{LAYOUT_LABELS[l]}</span>
                  <span className="block text-small text-text-2">{LAYOUT_DESCRIPTIONS[l]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.table} className="text-small text-text-2">
              Table
            </label>
            <select
              id={ids.table}
              className={selectClass}
              value={table}
              onChange={(e) => setTableId(e.target.value)}
            >
              {tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim() || !table || (!interfaceName && !ifaceName.trim())}
            >
              {busy ? 'Creating…' : 'Create page'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PageActions({
  baseId,
  iface,
  page,
  edit,
  onMode,
  onDeleted,
}: {
  baseId: string;
  iface: Interface;
  page: InterfacePage;
  edit: boolean;
  onMode: (edit: boolean) => void;
  onDeleted: () => void;
}) {
  const m = useInterfaceMutations(baseId);
  const state = publishState(page);
  const ids = { interfaceId: iface.id, pageId: page.id };
  const [sharing, setSharing] = useState(false);
  return (
    <>
      <ShareInterfaceDialog
        interfaceId={iface.id}
        name={iface.name}
        open={sharing}
        onOpenChange={setSharing}
      />
      <span role="status" className="text-small text-text-2 max-sm:hidden">
        {state === 'never'
          ? 'Not published'
          : state === 'changes'
            ? 'Unpublished changes'
            : 'Published'}
      </span>
      <fieldset className="flex rounded-sm border border-border" aria-label="Mode">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={edit}
          className={cn('rounded-none', edit && 'bg-selected text-primary')}
          onClick={() => onMode(true)}
        >
          <PencilIcon />
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={!edit}
          className={cn('rounded-none', !edit && 'bg-selected text-primary')}
          onClick={() => onMode(false)}
        >
          <EyeIcon />
          Preview
        </Button>
      </fieldset>
      {state !== 'never' && (
        <Button
          variant="ghost"
          onClick={() =>
            m.unpublish.mutate(ids, {
              onSuccess: () => toast.success('Unpublished: only creators and owners see it now'),
              onError: (err) => toast.error(problem(err, "Couldn't unpublish it")),
            })
          }
        >
          Unpublish
        </Button>
      )}
      <Button variant="ghost" onClick={() => setSharing(true)}>
        <UsersIcon />
        Share
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete page"
        onClick={() => {
          if (!window.confirm(`Delete the page "${page.name}"?`)) return;
          m.deletePage.mutate(ids, {
            onSuccess: onDeleted,
            onError: (err) => toast.error(problem(err, "Couldn't delete the page")),
          });
        }}
      >
        <Trash2Icon />
      </Button>
      <Button
        disabled={state === 'published' || m.publish.isPending}
        onClick={async () => {
          await pendingSaves.get(page.id)?.();
          m.publish.mutate(ids, {
            onSuccess: () => toast.success('Published'),
            onError: (err) => toast.error(problem(err, "Couldn't publish the page")),
          });
        }}
      >
        Publish
      </Button>
    </>
  );
}

/** Layouts drawn by PageRuntime: form, kanban, calendar and timeline pages. */
const RUNTIME_LAYOUTS: readonly InterfacePageConfig['layout'][] = [
  'form',
  'kanban',
  'calendar',
  'timeline',
];

/** The page: the designer (with its panel) for editors in edit mode, else the page itself. */
function PageBody({
  baseId,
  iface,
  page,
  canEdit,
  edit,
  userRole,
}: {
  baseId: string;
  iface: Interface;
  page: InterfacePage;
  canEdit: boolean;
  edit: boolean;
  userRole: ElementContext['userRole'];
}) {
  const shown = visibleConfig(page, canEdit);
  const m = useInterfaceMutations(baseId);
  // The designer edits a local copy, saved as the draft shortly after each change.
  const [draft, setDraft] = useState<InterfacePageConfig | null>(shown);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>;
    config: InterfacePageConfig;
  } | null>(null);
  const saveNow = m.updatePage.mutateAsync;
  const flush = async () => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    try {
      await saveNow({ interfaceId: iface.id, pageId: page.id, draft: p.config });
    } catch (err) {
      toast.error(problem(err, "Couldn't save the page"));
    }
  };
  const change = (next: InterfacePageConfig) => {
    setDraft(next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    // Half-typed settings (a URL) wait here until they are valid.
    const parsed = interfacePageConfigSchema.safeParse(next);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setInvalid(issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid settings');
      return;
    }
    setInvalid(null);
    pending.current = { timer: setTimeout(() => void flush(), 400), config: parsed.data };
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const run = () => flushRef.current();
    pendingSaves.set(page.id, run);
    return () => {
      void flushRef.current();
      if (pendingSaves.get(page.id) === run) pendingSaves.delete(page.id);
    };
  }, [page.id]);

  const config = edit ? draft : shown;
  const table = useQuery({ ...tableQueries.detail(config?.tableId ?? ''), enabled: !!config });
  if (!config) {
    return (
      <p className="p-6 text-text-2">
        This page's settings can't be read any more. Delete it and build it again.
      </p>
    );
  }
  if (table.isPending) return <Skeleton className="m-6 h-10" />;
  if (!table.data) return <p className="p-6 text-text-2">This page's table was deleted.</p>;

  const designer =
    edit && draft
      ? {
          selectedId,
          onSelect: setSelectedId,
          onChange: (el: InterfaceElement) =>
            change({ ...draft, elements: draft.elements.map((e) => (e.id === el.id ? el : e)) }),
          onRemove: (id: string) => {
            setSelectedId(null);
            change({ ...draft, elements: draft.elements.filter((e) => e.id !== id) });
          },
        }
      : undefined;

  const source = {
    baseId,
    interfaceId: iface.id,
    pageId: page.id,
    draft: canEdit && page.draft !== null,
  };
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {RUNTIME_LAYOUTS.includes(config.layout) ? (
          // The layouts of read the page through the interface's own routes.
          <PageRuntime config={config} pageName={page.name} source={source} designer={designer} />
        ) : (
          <PageView
            config={config}
            table={table.data}
            userRole={userRole}
            designer={designer}
            source={source}
          />
        )}
      </div>
      {designer && draft && (
        <DesignerPanel
          baseId={baseId}
          invalid={invalid}
          config={draft}
          table={table.data}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onChange={change}
        />
      )}
    </div>
  );
}

/** A page as its viewers see it: its records in a list (and the selected one), its elements. */
function PageView({
  config,
  table,
  userRole,
  designer,
  source,
}: {
  config: InterfacePageConfig;
  table: TableMeta;
  userRole: ElementContext['userRole'];
  designer: Parameters<typeof Canvas>[0]['designer'];
  source: PageSource;
}) {
  const [filterValues, setFilterValues] = useState<FilterValues>({});
  const [selected, setSelected] = useState<string | null>(null);
  const fields = table.fields;
  const within = elementConditions(config, filterValues, fields);
  const body = {
    query: {
      ...(config.filter ? { filter: config.filter } : {}),
      sorts: config.sorts,
      fields: pageFieldIds(config, fields),
      ...(within.length > 0 ? { within } : {}),
    },
    limit: PAGE_RECORDS,
  };
  const records = useQuery({
    queryKey: queryKeys.records.query(table.id, body),
    queryFn: () => api.records.query({ params: { tableId: table.id }, body }),
    placeholderData: keepPreviousData,
    // A dashboard lists no records: its numbers and charts come aggregated.
    enabled: config.layout !== 'dashboard',
  });
  const dataOf = useDashboardData(source, config, filterValues, fields);
  const rows: RecordData[] = records.data?.records ?? [];
  const record = rows.find((r) => r.id === selected) ?? rows[0];
  const primary = fields.find((f) => f.isPrimary);
  const columns = [
    ...(primary ? [primary] : []),
    ...config.fields.flatMap((id) => {
      const f = fields.find((x) => x.id === id && !x.isPrimary);
      return f ? [f] : [];
    }),
  ];
  const context: ElementContext = {
    table,
    record,
    userRole,
    filterValues,
    onFilterChange: (id, value) => setFilterValues((prev) => ({ ...prev, [id]: value })),
    dataOf,
  };
  const total = records.data?.total ?? null;
  const count = (
    <p className="text-small text-text-2" role="status">
      {records.isPending
        ? 'Loading…'
        : total === null
          ? `${rows.length} records`
          : total === 1
            ? '1 record'
            : `${total.toLocaleString()} records`}
    </p>
  );

  if (config.layout === 'dashboard') {
    return (
      <section aria-label="Dashboard" className="flex flex-col gap-4">
        <Canvas elements={config.elements} context={context} designer={designer} />
        {!designer && config.elements.length === 0 && (
          <p className="text-text-2">This dashboard has no numbers or charts yet.</p>
        )}
      </section>
    );
  }

  if (config.layout === 'recordList') {
    return (
      <div className="flex flex-col gap-4">
        <Canvas elements={config.elements} context={context} designer={designer} />
        {count}
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-body" aria-label={`${table.name} records`}>
            <thead>
              <tr className="h-[34px] border-b border-border text-left text-text-2">
                {columns.map((f) => (
                  <th key={f.id} scope="col" className="px-3 font-[550]">
                    {f.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="h-[34px] border-b border-border last:border-0">
                  {columns.map((f) => (
                    <td key={f.id} className="max-w-[320px] truncate px-3">
                      {cellText(f, r.fields[f.id])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 gap-4 max-md:flex-col">
      <section
        aria-label={`${table.name} records`}
        className="flex w-72 shrink-0 flex-col gap-2 max-md:w-full"
      >
        {count}
        <ul className="flex flex-col overflow-y-auto rounded-md border border-border bg-surface">
          {rows.map((r) => {
            const active = r.id === record?.id;
            return (
              <li key={r.id} className="border-b border-border last:border-0">
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setSelected(r.id)}
                  className={cn(
                    'flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-hover',
                    active && 'bg-selected'
                  )}
                >
                  <span className="w-full truncate font-[550] text-text">
                    {(primary && cellText(primary, r.fields[primary.id])) || 'Unnamed record'}
                  </span>
                  {columns.slice(1, 3).map((f) => (
                    <span key={f.id} className="w-full truncate text-small text-text-2">
                      {cellText(f, r.fields[f.id])}
                    </span>
                  ))}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="Selected record" className="min-w-0 flex-1">
        {record && primary && (
          <h2 className="mb-3 truncate text-[17px] font-[550]">
            {cellText(primary, record.fields[primary.id]) || 'Unnamed record'}
          </h2>
        )}
        <Canvas elements={config.elements} context={context} designer={designer} />
      </section>
    </div>
  );
}

/** The designer's side panel: the selected element's settings, or the page's. */
function DesignerPanel({
  baseId,
  invalid,
  config,
  table,
  selectedId,
  onSelect,
  onChange,
}: {
  baseId: string;
  invalid: string | null;
  config: InterfacePageConfig;
  table: TableMeta;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (config: InterfacePageConfig) => void;
}) {
  const selected = config.elements.find((e) => e.id === selectedId);
  const fields = table.fields;
  const filters = config.elements.filter((e) => e.type === 'filter').length;
  const dataElements = config.elements.filter(isDataElement).length;
  const add = (type: InterfaceElementType) => {
    const el = newElement(type, config.elements, fields, table.id);
    if (!el) {
      toast.error(`This table has no field a ${ELEMENT_LABELS[type].toLowerCase()} can show.`);
      return;
    }
    onChange({ ...config, elements: [...config.elements, el] });
    onSelect(el.id);
  };
  const setElement = (el: InterfaceElement) =>
    onChange({ ...config, elements: config.elements.map((e) => (e.id === el.id ? el : e)) });

  return (
    <aside
      aria-label="Page settings"
      className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-4 max-md:hidden"
    >
      {invalid && (
        <p role="alert" className="text-small text-danger">
          Not saved yet: {invalid}
        </p>
      )}
      {selected ? (
        <>
          <div className="flex items-center justify-between">
            <h2 className="font-[550]">{ELEMENT_LABELS[selected.type]}</h2>
            <Button variant="ghost" size="sm" onClick={() => onSelect(null)}>
              Done
            </Button>
          </div>
          {selected.type === 'number' || selected.type === 'chart' ? (
            <DataElementSettings
              baseId={baseId}
              element={selected}
              pageTable={table}
              onChange={setElement}
            />
          ) : (
            <ElementSettings
              element={selected}
              layout={config.layout}
              fields={fields}
              onChange={setElement}
            />
          )}
          <Button
            variant="ghost"
            className="self-start text-danger"
            onClick={() => {
              onSelect(null);
              onChange({
                ...config,
                elements: config.elements.filter((e) => e.id !== selected.id),
              });
            }}
          >
            <Trash2Icon />
            Remove element
          </Button>
        </>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="font-[550]">Add an element</h2>
            <div className="flex flex-wrap gap-2">
              {elementTypesFor(config.layout).map((t) => (
                <Button
                  key={t}
                  variant="secondary"
                  size="sm"
                  disabled={
                    (t === 'filter' && filters >= MAX_FILTER_ELEMENTS) ||
                    ((t === 'number' || t === 'chart') && dataElements >= MAX_DATA_ELEMENTS)
                  }
                  aria-label={`Add ${ELEMENT_LABELS[t].toLowerCase()}`}
                  onClick={() => add(t)}
                >
                  <PlusIcon />
                  {ELEMENT_LABELS[t]}
                </Button>
              ))}
            </div>
            <p className="text-small text-text-2">
              Drag elements to arrange them, or focus one and press Alt+arrows.
            </p>
          </section>
          <section className="flex flex-col gap-2">
            <h2 className="font-[550]">Records</h2>
            <p className="text-small text-text-2">
              {config.layout === 'dashboard'
                ? `${table.name}: this filter and the page's filters narrow its numbers and charts.`
                : `${table.name}: ${LAYOUT_LABELS[config.layout].toLowerCase()}`}
            </p>
            <p className="text-small text-text-2">
              Filter a user or Created by field by "Me" to show each viewer their own records.
            </p>
            <div className="flex flex-wrap gap-1">
              <FilterMenu
                fields={fields}
                filter={config.filter ?? { conjunction: 'and', conditions: [] }}
                onChange={(filter) => onChange({ ...config, filter })}
              />
              <SortMenu
                fields={fields}
                sorts={config.sorts}
                onChange={(sorts) =>
                  onChange({
                    ...config,
                    sorts: sorts.map((s) => ({ fieldId: s.fieldId, direction: s.direction })),
                  })
                }
              />
            </div>
          </section>
          <LayoutSettings config={config} fields={fields} onChange={onChange} />
          {(config.layout === 'recordList' || config.layout === 'recordReview') && (
            <ListFields config={config} fields={fields} onChange={onChange} />
          )}
        </>
      )}
    </aside>
  );
}

function ListFields({
  config,
  fields,
  onChange,
}: {
  config: InterfacePageConfig;
  fields: FieldMeta[];
  onChange: (config: InterfacePageConfig) => void;
}) {
  const shown = new Set(config.fields);
  const others = useMemo(() => fields.filter((f) => !f.isPrimary), [fields]);
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 font-[550]">Fields in the list</legend>
      {others.map((f) => (
        <label key={f.id} className="flex h-7 items-center gap-2 text-text">
          <input
            type="checkbox"
            checked={shown.has(f.id)}
            disabled={!shown.has(f.id) && config.fields.length >= MAX_INTERFACE_LIST_FIELDS}
            onChange={(e) =>
              onChange({
                ...config,
                fields: e.target.checked
                  ? [...config.fields, f.id]
                  : config.fields.filter((id) => id !== f.id),
              })
            }
            className="size-4 accent-[var(--accent)]"
          />
          <span className="truncate">{f.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ElementSettings({
  element,
  layout,
  fields,
  onChange,
}: {
  element: InterfaceElement;
  layout: InterfaceLayout;
  fields: FieldMeta[];
  onChange: (element: InterfaceElement) => void;
}) {
  const id = useId();
  const fieldSelect = (value: string, options: FieldMeta[], set: (fieldId: string) => void) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-field`} className="text-small text-text-2">
        Field
      </label>
      <select
        id={`${id}-field`}
        className={selectClass}
        value={value}
        onChange={(e) => set(e.target.value)}
      >
        {options.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </div>
  );
  switch (element.type) {
    case 'number':
    case 'chart':
      return null;
    case 'text':
      return (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-text`} className="text-small text-text-2">
            Text (Markdown)
          </label>
          <textarea
            id={`${id}-text`}
            value={element.content}
            maxLength={10_000}
            rows={8}
            onChange={(e) => onChange({ ...element, content: e.target.value })}
            className="rounded-sm border border-border bg-surface p-2 text-body text-text hover:border-border-strong"
          />
        </div>
      );
    case 'filter':
      return (
        <>
          {fieldSelect(element.fieldId, filterableFields(fields), (fieldId) =>
            onChange({ ...element, fieldId })
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-label`} className="text-small text-text-2">
              Label
            </label>
            <Input
              id={`${id}-label`}
              value={element.label}
              placeholder="The field's name"
              maxLength={100}
              onChange={(e) => onChange({ ...element, label: e.target.value })}
            />
          </div>
        </>
      );
    case 'field':
      return (
        <>
          {fieldSelect(element.fieldId, fields, (fieldId) => onChange({ ...element, fieldId }))}
          <label className="flex items-center gap-2 text-text">
            <input
              type="checkbox"
              checked={element.editable}
              onChange={(e) => onChange({ ...element, editable: e.target.checked })}
              className="size-4 accent-[var(--accent)]"
            />
            Editable (by editors and up)
          </label>
        </>
      );
    case 'button': {
      const buttons = automationButtons(fields);
      const action = element.action;
      return (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-label`} className="text-small text-text-2">
              Label
            </label>
            <Input
              id={`${id}-label`}
              value={element.label}
              maxLength={100}
              onChange={(e) => onChange({ ...element, label: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-action`} className="text-small text-text-2">
              When clicked
            </label>
            <select
              id={`${id}-action`}
              className={selectClass}
              value={action.type}
              onChange={(e) => {
                const first = buttons[0];
                if (e.target.value === 'runAutomation' && first) {
                  onChange({ ...element, action: { type: 'runAutomation', fieldId: first.id } });
                } else {
                  onChange({
                    ...element,
                    action: { type: 'openUrl', url: 'https://openrows.io' },
                  });
                }
              }}
            >
              <option value="openUrl">Open a URL</option>
              <option
                value="runAutomation"
                disabled={buttons.length === 0 || layout !== 'recordReview'}
              >
                Run a button's automations (selected record)
              </option>
            </select>
          </div>
          {action.type === 'openUrl' ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-url`} className="text-small text-text-2">
                URL
              </label>
              <Input
                id={`${id}-url`}
                type="url"
                value={action.url}
                maxLength={2048}
                onChange={(e) =>
                  onChange({ ...element, action: { ...action, url: e.target.value } })
                }
              />
            </div>
          ) : (
            fieldSelect(action.fieldId, buttons, (fieldId) =>
              onChange({ ...element, action: { type: 'runAutomation', fieldId } })
            )
          )}
        </>
      );
    }
  }
}
