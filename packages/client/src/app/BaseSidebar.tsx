import {
  type Base,
  downloads,
  type MeResponse,
  SHAREABLE_VIEW_TYPES,
  type TableMeta,
  type ViewMeta,
  type ViewSection,
} from '@openrows/shared';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  FolderPlusIcon,
  HistoryIcon,
  HomeIcon,
  LayoutTemplateIcon,
  Link2Icon,
  LockIcon,
  LockOpenIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Table2Icon,
  Trash2Icon,
  TrashIcon,
  UserRoundIcon,
  UsersRoundIcon,
  WebhookIcon,
} from 'lucide-react';
import { type DragEvent, type ReactNode, useState } from 'react';
import { ApiError, downloadUrl } from '../api/client';
import {
  useCreateTable,
  useCreateViewSection,
  useDeleteBase,
  useDeleteTable,
  useDeleteView,
  useDeleteViewSection,
  useDuplicateView,
  useUpdateTable,
  useUpdateView,
  useUpdateViewSection,
} from '../api/queries';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  toast,
} from '../components/ui';
import { DuplicateBaseDialog } from '../features/duplicate/DuplicateBaseDialog';
import { TablePermissionsDialog } from '../features/permissions/TablePermissionsDialog';
import { FormLinkDialog } from '../features/share/FormLinkDialog';
import { ShareViewDialog } from '../features/share/ShareViewDialog';
import { SnapshotsDialog } from '../features/snapshots/SnapshotsDialog';
import { SyncDataDialog } from '../features/syncs/SyncDataDialog';
import { BaseTrashDialog } from '../features/trash/TrashDialog';
import { WebhooksDialog } from '../features/webhooks/WebhooksDialog';
import { cn } from '../lib/utils';
import { CreateViewMenu, ViewTypeIcon } from './CreateView';
import { InlineRename } from './InlineRename';
import { Logo } from './Logo';
import { movedPosition, nextFreeName, nextNumberedName } from './names';
import { AccountRow, CommandHint, NavItem, SectionLabel } from './Shell';
import {
  dropTarget,
  sectionDropPosition,
  sidebarGroups,
  type ViewGroup,
  viewGroups,
} from './viewSections';

type TableSummary = Omit<TableMeta, 'fields'>;

const failed = (what: string) => (err: unknown) =>
  toast.error(err instanceof ApiError ? err.message : `Couldn't ${what}`);

/** The sidebar inside a base: base switcher, TABLES, VIEWS of the open table, account. */
export function BaseSidebar({
  me,
  base,
  tables,
  views,
  sections = [],
  tableId,
  viewId,
}: {
  me: MeResponse;
  base?: Base;
  tables?: TableSummary[];
  views?: ViewMeta[];
  /** The table's view sections. */
  sections?: ViewSection[];
  tableId: string;
  viewId?: string;
}) {
  const navigate = useNavigate();
  const canEditSchema = base?.role === 'owner' || base?.role === 'creator';
  const canEditViews = canEditSchema || base?.role === 'editor';
  const baseId = base?.id ?? '';
  const createTable = useCreateTable(baseId);
  const createSection = useCreateViewSection(tableId);
  const removeBase = useDeleteBase(baseId);
  const [trashOpen, setTrashOpen] = useState(false);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  // Back from a sync connector's consent page: the "Sync data" dialog opens again.
  const [syncOpen, setSyncOpen] = useState(() =>
    new URLSearchParams(window.location.search).has('syncConnector')
  );

  const addTable = () =>
    createTable.mutate(
      {
        name: nextNumberedName(
          'Table',
          (tables ?? []).map((t) => t.name)
        ),
      },
      {
        onSuccess: (t) =>
          navigate({ to: '/b/$baseId/$tableId', params: { baseId, tableId: t.id } }),
        onError: failed('create the table'),
      }
    );
  const addSection = () =>
    createSection.mutate(
      {
        name: nextFreeName(
          'New section',
          sections.map((s) => s.name)
        ),
      },
      { onError: failed('create the section') }
    );

  return (
    <>
      <div className="flex h-[52px] items-center px-4">
        <Logo />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="mx-3 mb-2 flex h-9 items-center justify-between rounded-sm border border-border bg-surface px-2.5 hover:bg-hover"
          aria-label="Switch base"
        >
          <span className="truncate font-[550]">{base?.name ?? '…'}</span>
          <ChevronDownIcon className="size-4 text-text-2" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onSelect={() => navigate({ to: '/' })}>
            <HomeIcon />
            All bases
          </DropdownMenuItem>
          {canEditViews && (
            <DropdownMenuItem onSelect={() => setTrashOpen(true)}>
              <Trash2Icon />
              Trash
            </DropdownMenuItem>
          )}
          {canEditSchema && (
            <DropdownMenuItem onSelect={() => setDuplicateOpen(true)}>
              <CopyIcon />
              Duplicate base
            </DropdownMenuItem>
          )}
          {canEditSchema && (
            <DropdownMenuItem onSelect={() => setSnapshotsOpen(true)}>
              <HistoryIcon />
              Snapshots
            </DropdownMenuItem>
          )}
          {canEditSchema && (
            <DropdownMenuItem onSelect={() => setWebhooksOpen(true)}>
              <WebhookIcon />
              Webhooks
            </DropdownMenuItem>
          )}
          {canEditSchema && base && (
            // The base in the template format: to keep, share or add to a server's templates.
            <DropdownMenuItem asChild>
              <a
                href={downloadUrl(downloads.baseTemplate, { params: { baseId: base.id } })}
                download
              >
                <LayoutTemplateIcon />
                Save as template
              </a>
            </DropdownMenuItem>
          )}
          {base && (
            // The whole base as a ZIP: every reader may download what they can read.
            <DropdownMenuItem asChild>
              <a href={downloadUrl(downloads.baseExport, { params: { baseId: base.id } })} download>
                <DownloadIcon />
                Export base (ZIP)
              </a>
            </DropdownMenuItem>
          )}
          {canEditSchema && base && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  if (!window.confirm(`Delete the base "${base.name}"? It goes to the trash.`)) {
                    return;
                  }
                  removeBase.mutate(undefined, {
                    onSuccess: () => {
                      toast.success(`Moved ${base.name} to the trash`);
                      navigate({ to: '/' });
                    },
                    onError: failed('delete the base'),
                  });
                }}
              >
                <TrashIcon />
                Delete base
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {base && tables && canEditViews && (
        <BaseTrashDialog
          base={base}
          tables={tables}
          tableId={tableId}
          open={trashOpen}
          onOpenChange={setTrashOpen}
        />
      )}

      {base && canEditSchema && (
        <DuplicateBaseDialog base={base} open={duplicateOpen} onOpenChange={setDuplicateOpen} />
      )}
      {base && canEditSchema && (
        <SyncDataDialog base={base} open={syncOpen} onOpenChange={setSyncOpen} />
      )}
      {base && canEditSchema && (
        <SnapshotsDialog base={base} open={snapshotsOpen} onOpenChange={setSnapshotsOpen} />
      )}
      {base && canEditSchema && (
        <WebhooksDialog
          base={base}
          tables={tables ?? []}
          open={webhooksOpen}
          onOpenChange={setWebhooksOpen}
        />
      )}

      <SectionLabel>Tables</SectionLabel>
      <nav aria-label="Tables" className="flex flex-col gap-0.5 py-1">
        {!tables ? (
          <ListSkeleton />
        ) : (
          tables.map((t, i) => (
            <TableItem
              key={t.id}
              table={t}
              tables={tables}
              index={i}
              active={t.id === tableId}
              editable={canEditSchema}
            />
          ))
        )}
        {canEditSchema && (
          <>
            <AddButton onClick={addTable} disabled={createTable.isPending}>
              Add table
            </AddButton>
            {/* A table synced from another base or view. */}
            <AddButton
              onClick={() => setSyncOpen(true)}
              icon={<RefreshCwIcon className="size-4" />}
            >
              Sync data
            </AddButton>
          </>
        )}
      </nav>

      <SectionLabel>Views</SectionLabel>
      <nav aria-label="Views" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-1">
        {!views ? (
          <ListSkeleton />
        ) : (
          <ViewGroups
            me={me}
            views={views}
            sections={sections}
            baseId={baseId}
            tableId={tableId}
            viewId={viewId}
            editable={canEditViews}
            canLock={canEditSchema}
          />
        )}
        {canEditViews && (
          <>
            <CreateViewMenu baseId={baseId} tableId={tableId} />
            <AddButton
              onClick={addSection}
              disabled={createSection.isPending}
              icon={<FolderPlusIcon className="size-4" />}
            >
              New section
            </AddButton>
          </>
        )}
      </nav>
      <CommandHint />
      <AccountRow me={me} />
    </>
  );
}

function ListSkeleton() {
  return (
    <div className="grid gap-2 px-4 py-1">
      <Skeleton className="h-5 w-3/4" />
      <Skeleton className="h-5 w-1/2" />
    </div>
  );
}

function AddButton({
  children,
  onClick,
  disabled,
  icon = <PlusIcon className="size-4" />,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mx-2 flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-text-2 hover:bg-hover hover:text-text disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}

/** The "…" menu on a sidebar item, shown on hover, focus or when active. */
function ItemMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className="absolute top-1 right-3 flex size-6 items-center justify-center rounded-xs text-text-2 opacity-0 group-hover:opacity-100 hover:bg-hover focus-visible:opacity-100 data-[state=open]:opacity-100"
      >
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

function TableItem({
  table,
  tables,
  index,
  active,
  editable,
}: {
  table: TableSummary;
  tables: TableSummary[];
  index: number;
  active: boolean;
  editable: boolean;
}) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [permissions, setPermissions] = useState(false);
  const update = useUpdateTable(table.id);
  const remove = useDeleteTable(table.id);
  const move = (dir: -1 | 1) => {
    const position = movedPosition(tables, index, dir);
    if (position !== null) update.mutate({ position }, { onError: failed('move the table') });
  };

  if (renaming) {
    return (
      <InlineRename
        value={table.name}
        label="Table name"
        onDone={() => setRenaming(false)}
        onSubmit={(name) => update.mutate({ name }, { onError: failed('rename the table') })}
      />
    );
  }
  return (
    <div className="group relative">
      <NavItem
        to="/b/$baseId/$tableId"
        params={{ baseId: table.baseId, tableId: table.id }}
        active={active}
        icon={table.synced ? <RefreshCwIcon aria-label="Synced" /> : <Table2Icon />}
        className="pr-9"
        onDoubleClick={() => editable && setRenaming(true)}
      >
        {table.name}
      </NavItem>
      {editable && (
        <ItemMenu label={`${table.name} options`}>
          <DropdownMenuItem onSelect={() => setRenaming(true)}>
            <PencilIcon />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === 0} onSelect={() => move(-1)}>
            <ArrowUpIcon />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === tables.length - 1} onSelect={() => move(1)}>
            <ArrowDownIcon />
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPermissions(true)}>
            <ShieldCheckIcon />
            Edit permissions
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={tables.length <= 1}
            onSelect={() => {
              if (!window.confirm(`Delete the table "${table.name}"? It goes to the trash.`)) {
                return;
              }
              const next = tables.find((t) => t.id !== table.id);
              remove.mutate(undefined, {
                onSuccess: () => {
                  toast.success(`Deleted ${table.name}`);
                  if (active && next) {
                    navigate({
                      to: '/b/$baseId/$tableId',
                      params: { baseId: table.baseId, tableId: next.id },
                    });
                  }
                },
                onError: failed('delete the table'),
              });
            }}
          >
            <TrashIcon />
            Delete table
          </DropdownMenuItem>
        </ItemMenu>
      )}
      {permissions && (
        <TablePermissionsDialog table={table} onClose={() => setPermissions(false)} />
      )}
    </div>
  );
}

/** Drag payload types of the sidebar: a view or a view section. */
const VIEW_DRAG = 'application/x-openrows-view';
const SECTION_DRAG = 'application/x-openrows-section';

const dragging = (e: DragEvent, type: string) => e.dataTransfer.types.includes(type);

/**
 * The views of the open table: the collaborative ones outside any section first, then by
 * section; then the user's personal views apart, under "My views", by the same sections
 * . Views and sections can be dragged to reorder (a view dropped on another goes right
 * before it, in its section; dropped on a section's header, to the end of that section); the
 * "…" menus do the same from the keyboard.
 */
function ViewGroups({
  me,
  views,
  sections,
  baseId,
  tableId,
  viewId,
  editable,
  canLock,
}: {
  me: MeResponse;
  views: ViewMeta[];
  sections: ViewSection[];
  baseId: string;
  tableId: string;
  viewId: string | undefined;
  editable: boolean;
  canLock: boolean;
}) {
  const update = useUpdateView(tableId);
  const { shared, mine } = sidebarGroups(views, sections);
  // Where a personal view can move to: its place among the personal views of every section.
  const personalTargets = viewGroups(
    views.filter((v) => v.personal),
    sections
  );
  const moveView = (id: string, group: ViewGroup, target: ViewMeta | null) =>
    update.mutate(
      { viewId: id, ...dropTarget(group, id, target) },
      { onError: failed('move the view') }
    );
  const collaborative = views.filter((v) => !v.personal).length;
  const itemsOf = (group: ViewGroup, groups: ViewGroup[]) =>
    group.views.map((v, i) => (
      <ViewItem
        key={v.id}
        me={me}
        view={v}
        group={group}
        index={i}
        groups={groups}
        views={views}
        baseId={baseId}
        active={v.id === viewId}
        editable={editable}
        canLock={canLock}
        canDelete={v.personal || collaborative > 1}
        onMove={moveView}
      />
    ));
  const plain = (group: ViewGroup, key: string, children: ReactNode) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target; the menus move views
    <div
      key={key}
      className="flex flex-col gap-0.5"
      onDragOver={(e) => editable && dragging(e, VIEW_DRAG) && e.preventDefault()}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(VIEW_DRAG);
        if (!editable || !id) return;
        e.preventDefault();
        e.stopPropagation();
        moveView(id, group, null);
      }}
    >
      {children}
    </div>
  );
  return (
    <>
      {shared.map((group) =>
        group.section ? (
          <SectionGroup
            key={group.section.id}
            section={group.section}
            sections={sections}
            group={group}
            editable={editable}
            onMoveView={moveView}
          >
            {itemsOf(group, shared)}
          </SectionGroup>
        ) : (
          plain(group, 'no-section', itemsOf(group, shared))
        )
      )}
      {mine.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: a labelled group of links inside the nav
        <div role="group" aria-labelledby={`${tableId}-my-views`} data-testid="my-views">
          <div
            id={`${tableId}-my-views`}
            className="mx-2 mt-3 mb-0.5 flex h-6 items-center gap-2 px-2.5 text-small font-[550] text-text-2"
          >
            <UserRoundIcon className="size-3.5" aria-hidden />
            My views
          </div>
          {mine.map((group) =>
            plain(
              group,
              group.section?.id ?? 'no-section',
              <>
                {group.section && (
                  <div className="mx-2 flex h-7 items-center gap-2 px-2.5 text-small text-text-2">
                    <FolderIcon className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{group.section.name}</span>
                  </div>
                )}
                <div className={cn('flex flex-col gap-0.5', group.section && 'pl-3')}>
                  {itemsOf(group, personalTargets)}
                </div>
              </>
            )
          )}
        </div>
      )}
    </>
  );
}

function SectionGroup({
  section,
  sections,
  group,
  editable,
  onMoveView,
  children,
}: {
  section: ViewSection;
  sections: ViewSection[];
  group: ViewGroup;
  editable: boolean;
  onMoveView: (id: string, group: ViewGroup, target: ViewMeta | null) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [over, setOver] = useState(false);
  const update = useUpdateViewSection(section.tableId);
  const remove = useDeleteViewSection(section.tableId);
  const ordered = [...sections].sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((s) => s.id === section.id);
  const move = (dir: -1 | 1) => {
    const position = movedPosition(ordered, index, dir);
    if (position !== null) {
      update.mutate({ sectionId: section.id, position }, { onError: failed('move the section') });
    }
  };
  const onDrop = (e: DragEvent) => {
    setOver(false);
    if (!editable) return;
    const viewId = e.dataTransfer.getData(VIEW_DRAG);
    const sectionId = e.dataTransfer.getData(SECTION_DRAG);
    if (viewId) {
      e.preventDefault();
      e.stopPropagation();
      onMoveView(viewId, group, null);
    } else if (sectionId && sectionId !== section.id) {
      e.preventDefault();
      update.mutate(
        { sectionId, position: sectionDropPosition(sections, sectionId, section) },
        { onError: failed('move the section') }
      );
    }
  };
  return (
    <div className="mt-1 flex flex-col gap-0.5" data-section={section.name}>
      {renaming ? (
        <InlineRename
          value={section.name}
          label="Section name"
          onDone={() => setRenaming(false)}
          onSubmit={(name) =>
            update.mutate(
              { sectionId: section.id, name },
              { onError: failed('rename the section') }
            )
          }
        />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: drag source and drop target; the menu moves sections
        <div
          className={cn(
            'group relative',
            over && 'before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:bg-accent'
          )}
          draggable={editable}
          onDragStart={(e) => {
            e.dataTransfer.setData(SECTION_DRAG, section.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => {
            if (!editable || (!dragging(e, VIEW_DRAG) && !dragging(e, SECTION_DRAG))) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          data-testid="view-section"
        >
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            onDoubleClick={() => editable && setRenaming(true)}
            className="mx-2 flex h-8 w-[calc(100%-1rem)] items-center gap-2 rounded-sm px-2.5 pr-9 text-left text-text-2 hover:bg-hover hover:text-text"
          >
            {open ? (
              <ChevronDownIcon className="size-4 shrink-0" aria-hidden />
            ) : (
              <ChevronRightIcon className="size-4 shrink-0" aria-hidden />
            )}
            <FolderIcon className="size-4 shrink-0" aria-hidden />
            <span className="truncate font-[550]">{section.name}</span>
          </button>
          {editable && (
            <ItemMenu label={`${section.name} section options`}>
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <PencilIcon />
                Rename section
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index <= 0} onSelect={() => move(-1)}>
                <ArrowUpIcon />
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index === ordered.length - 1} onSelect={() => move(1)}>
                <ArrowDownIcon />
                Move down
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                  remove.mutate(section.id, {
                    onSuccess: () => toast.success(`Deleted the section ${section.name}`),
                    onError: failed('delete the section'),
                  })
                }
              >
                <TrashIcon />
                Delete section
              </DropdownMenuItem>
            </ItemMenu>
          )}
        </div>
      )}
      {open && <div className="flex flex-col gap-0.5 pl-3">{children}</div>}
    </div>
  );
}

function ViewItem({
  me,
  view,
  group,
  index,
  groups,
  views,
  baseId,
  active,
  editable,
  canLock,
  canDelete,
  onMove,
}: {
  me: MeResponse;
  view: ViewMeta;
  group: ViewGroup;
  index: number;
  groups: ViewGroup[];
  views: ViewMeta[];
  baseId: string;
  active: boolean;
  editable: boolean;
  canLock: boolean;
  canDelete: boolean;
  onMove: (id: string, group: ViewGroup, target: ViewMeta | null) => void;
}) {
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [over, setOver] = useState(false);
  const [sharing, setSharing] = useState(false);
  // Public share links: creators and owners, grid views for now; a form view's link is
  // its public form.
  const shareable = canLock && (SHAREABLE_VIEW_TYPES as readonly string[]).includes(view.type);
  const publishable = canLock && view.type === 'form';
  const update = useUpdateView(view.tableId);
  const duplicate = useDuplicateView(view.tableId);
  const remove = useDeleteView(view.tableId);
  const params = { baseId, tableId: view.tableId };
  // A locked view's name and settings are for creators and owners.
  const configurable = editable && (!view.locked || canLock);
  const mine = view.createdBy === me.user.id;
  const change = (body: Parameters<typeof update.mutate>[0], what: string) =>
    update.mutate(body, { onError: failed(what) });
  const step = (dir: -1 | 1) => {
    const position = movedPosition(group.views, index, dir);
    if (position !== null) change({ viewId: view.id, position }, 'move the view');
  };

  if (renaming) {
    return (
      <InlineRename
        value={view.name}
        label="View name"
        onDone={() => setRenaming(false)}
        onSubmit={(name) => change({ viewId: view.id, name }, 'rename the view')}
      />
    );
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag source and drop target; the menu moves views
    <div
      className={cn(
        'group relative',
        over &&
          'before:absolute before:inset-x-3 before:top-0 before:z-10 before:h-0.5 before:bg-accent'
      )}
      draggable={editable}
      onDragStart={(e) => {
        e.dataTransfer.setData(VIEW_DRAG, view.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (!editable || !dragging(e, VIEW_DRAG)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(VIEW_DRAG);
        if (!editable || !id) return;
        e.preventDefault();
        e.stopPropagation();
        if (id !== view.id) onMove(id, group, view);
      }}
      data-testid="view-item"
    >
      <NavItem
        to="/b/$baseId/$tableId/$viewId"
        params={{ ...params, viewId: view.id }}
        active={active}
        icon={<ViewTypeIcon type={view.type} />}
        className="pr-9"
        onDoubleClick={() => configurable && setRenaming(true)}
      >
        {view.name}
        {view.personal && (
          <UserRoundIcon className="ml-1.5 inline align-[-3px]" aria-label="Personal view" />
        )}
        {view.locked && (
          <LockIcon className="ml-1.5 inline align-[-3px]" aria-label="Locked view" />
        )}
      </NavItem>
      {editable && (
        <ItemMenu label={`${view.name} options`}>
          {configurable && (
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() =>
              duplicate.mutate(view.id, {
                onSuccess: (copy) =>
                  navigate({
                    to: '/b/$baseId/$tableId/$viewId',
                    params: { ...params, viewId: copy.id },
                  }),
                onError: failed('duplicate the view'),
              })
            }
          >
            <CopyIcon />
            Duplicate
          </DropdownMenuItem>
          {shareable && (
            <DropdownMenuItem onSelect={() => setSharing(true)}>
              <Link2Icon />
              Share view
            </DropdownMenuItem>
          )}
          {publishable && (
            <DropdownMenuItem onSelect={() => setSharing(true)}>
              <Link2Icon />
              Share form
            </DropdownMenuItem>
          )}
          {canLock && (
            <DropdownMenuItem
              onSelect={() =>
                change(
                  { viewId: view.id, locked: !view.locked },
                  view.locked ? 'unlock the view' : 'lock the view'
                )
              }
            >
              {view.locked ? <LockOpenIcon /> : <LockIcon />}
              {view.locked ? 'Unlock view' : 'Lock view'}
            </DropdownMenuItem>
          )}
          {mine && (
            <DropdownMenuItem
              disabled={!view.personal && views.filter((v) => !v.personal).length <= 1}
              onSelect={() =>
                change({ viewId: view.id, personal: !view.personal }, 'change who sees the view')
              }
            >
              {view.personal ? <UsersRoundIcon /> : <UserRoundIcon />}
              {view.personal ? 'Make collaborative' : 'Make personal'}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={index === 0} onSelect={() => step(-1)}>
            <ArrowUpIcon />
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={index === group.views.length - 1} onSelect={() => step(1)}>
            <ArrowDownIcon />
            Move down
          </DropdownMenuItem>
          {groups.length > 1 && (
            <>
              <DropdownMenuLabel>Move to section</DropdownMenuLabel>
              {groups
                .filter((g) => g.section?.id !== group.section?.id)
                .map((g) => (
                  <DropdownMenuItem
                    key={g.section?.id ?? 'none'}
                    onSelect={() => onMove(view.id, g, null)}
                  >
                    <FolderIcon />
                    {g.section?.name ?? 'No section'}
                  </DropdownMenuItem>
                ))}
            </>
          )}
          {configurable && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={!canDelete}
                onSelect={() => {
                  const next = views.find((v) => v.id !== view.id);
                  remove.mutate(view.id, {
                    onSuccess: () => {
                      toast.success(`Deleted ${view.name}`);
                      if (active && next) {
                        navigate({
                          to: '/b/$baseId/$tableId/$viewId',
                          params: { ...params, viewId: next.id },
                        });
                      }
                    },
                    onError: failed('delete the view'),
                  });
                }}
              >
                <TrashIcon />
                Delete view
              </DropdownMenuItem>
            </>
          )}
        </ItemMenu>
      )}
      {shareable && <ShareViewDialog view={view} open={sharing} onOpenChange={setSharing} />}
      {publishable && <FormLinkDialog view={view} open={sharing} onOpenChange={setSharing} />}
    </div>
  );
}
