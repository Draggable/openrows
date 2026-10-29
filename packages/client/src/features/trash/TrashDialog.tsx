import type { Base, TableMeta, Workspace } from '@openrows/shared';
import {
  DatabaseIcon,
  EyeIcon,
  RotateCcwIcon,
  Rows3Icon,
  Table2Icon,
  Trash2Icon,
} from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  type TrashTarget,
  useBaseTrash,
  usePurgeBase,
  usePurgeFromTrash,
  useRecordTrash,
  useRestoreBase,
  useRestoreFromTrash,
  useWorkspaceTrash,
} from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Skeleton,
  toast,
} from '../../components/ui';
import { cn } from '../../lib/utils';
import { CollaboratorsProvider } from '../collaborators/context';
import { UserChip } from '../collaborators/UserChip';
import { FIELD_TYPE_ICONS } from '../fields/icons';
import {
  canPurge,
  canRestore,
  deletedAgo,
  purgeStatus,
  recordLabel,
  TAB_LABELS,
  TRASH_TABS,
  type TrashTab,
} from './model';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

const confirmPurge = (name: string) =>
  window.confirm(`Delete "${name}" permanently? This can't be undone.`);

const selectClass =
  'h-8 rounded-sm border border-border bg-surface px-2 text-body hover:bg-hover pointer-coarse:h-[40px]';

interface Item {
  key: string;
  name: string;
  icon: ReactNode;
  /** Where it was, e.g. "in Tasks". */
  where?: string;
  deletedAt: string;
  deletedBy: string | null;
  purgeAfter: string;
  target: TrashTarget;
}

/**
 * A base's trash (editors and up): deleted records (per table), fields, views and tables,
 * who deleted them and when, with Restore and, for creators and owners, "Delete permanently".
 * Items past the 30 days are shown as "will be purged".
 */
export function BaseTrashDialog({
  base,
  tables,
  tableId,
  open,
  onOpenChange,
}: {
  base: Base;
  tables: Omit<TableMeta, 'fields'>[];
  tableId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tab, setTab] = useState<TrashTab>('records');
  const [chosenTable, setChosenTable] = useState(tableId);
  const recordTable = tables.some((t) => t.id === chosenTable) ? chosenTable : tableId;
  const trash = useBaseTrash(base.id, open);
  const records = useRecordTrash(recordTable, open && tab === 'records');
  const restore = useRestoreFromTrash(base.id);
  const purge = usePurgeFromTrash(base.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one clock per opening.
  const now = useMemo(() => Date.now(), [open]);
  const id = useId();
  const role = base.role;
  const tableName = tables.find((t) => t.id === recordTable)?.name ?? '';

  const items: Record<TrashTab, Item[] | undefined> = {
    records: records.data?.pages.flatMap((p) =>
      p.records.map((r) => ({
        key: r.id,
        name: recordLabel(r.name),
        icon: <Rows3Icon />,
        deletedAt: r.deletedAt,
        deletedBy: r.deletedBy,
        purgeAfter: r.purgeAfter,
        target: { kind: 'record' as const, tableId: recordTable, ids: [r.id] },
      }))
    ),
    fields: trash.data?.fields.map((f) => {
      const Icon = FIELD_TYPE_ICONS[f.type];
      return {
        key: f.id,
        name: f.name,
        icon: <Icon />,
        where: f.inverse
          ? `in ${f.tableName}, with "${f.inverse.name}" in ${f.inverse.tableName}`
          : `in ${f.tableName}`,
        deletedAt: f.deletedAt,
        deletedBy: f.deletedBy,
        purgeAfter: f.purgeAfter,
        target: { kind: 'field' as const, tableId: f.tableId, id: f.id },
      };
    }),
    views: trash.data?.views.map((v) => ({
      key: v.id,
      name: v.name,
      icon: <EyeIcon />,
      where: `in ${v.tableName}${v.personal ? ' (personal)' : ''}`,
      deletedAt: v.deletedAt,
      deletedBy: v.deletedBy,
      purgeAfter: v.purgeAfter,
      target: { kind: 'view' as const, tableId: v.tableId, id: v.id },
    })),
    tables: trash.data?.tables.map((t) => ({
      key: t.id,
      name: t.name,
      icon: <Table2Icon />,
      deletedAt: t.deletedAt,
      deletedBy: t.deletedBy,
      purgeAfter: t.purgeAfter,
      target: { kind: 'table' as const, id: t.id },
    })),
  };
  const shown = items[tab];
  const loading = tab === 'records' ? records.isPending : trash.isPending;

  const onRestore = (item: Item) =>
    restore.mutate(item.target, {
      onSuccess: () => toast.success(`Restored "${item.name}"`),
      onError: (err) => toast.error(message(err, `Couldn't restore "${item.name}"`)),
    });
  const onPurge = (item: Item) => {
    if (!confirmPurge(item.name)) return;
    purge.mutate(item.target, {
      onSuccess: () => toast.success(`Deleted "${item.name}" permanently`),
      onError: (err) => toast.error(message(err, `Couldn't delete "${item.name}"`)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Trash</DialogTitle>
          <DialogDescription>
            Deleted items of {base.name} stay here for 30 days. Restore them, or delete them
            permanently.
          </DialogDescription>
        </DialogHeader>
        <div
          role="tablist"
          aria-label="Trash"
          className="flex shrink-0 gap-4 border-b border-border"
        >
          {TRASH_TABS.map((t) => {
            const count = t === 'records' ? undefined : items[t]?.length;
            return (
              <button
                key={t}
                id={`${id}-${t}`}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls={`${id}-panel`}
                onClick={() => setTab(t)}
                className={cn(
                  '-mb-px flex h-9 items-center gap-1.5 border-b-2 border-transparent text-text-2 outline-none hover:text-text focus-visible:text-text',
                  tab === t && 'border-primary font-semibold text-text'
                )}
              >
                {TAB_LABELS[t]}
                {count !== undefined && count > 0 && (
                  <span className="rounded-xs border border-border px-1 text-small font-normal text-text-2">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-${tab}`}
          className="flex min-h-[180px] flex-1 flex-col gap-2"
        >
          {tab === 'records' && (
            <label className="flex items-center gap-2 text-small text-text-2">
              Table
              <select
                className={selectClass}
                value={recordTable}
                onChange={(e) => setChosenTable(e.target.value)}
              >
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <TrashList
            label={tab === 'records' ? `Deleted records of ${tableName}` : `Deleted ${tab}`}
            items={shown}
            loading={loading}
            empty={
              tab === 'records'
                ? `No deleted records in ${tableName}.`
                : `No deleted ${TAB_LABELS[tab].toLowerCase()}.`
            }
            now={now}
            canRestore={canRestore(tab, role)}
            canPurge={canPurge(role)}
            busy={restore.isPending || purge.isPending}
            onRestore={onRestore}
            onPurge={onPurge}
          />
          {tab === 'records' && records.hasNextPage && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              disabled={records.isFetchingNextPage}
              onClick={() => records.fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A workspace's trash (creators and up): its deleted bases, with Restore and "Delete
 * permanently".
 */
export function WorkspaceTrashDialog({
  workspace,
  meId,
  open,
  onOpenChange,
}: {
  workspace: Workspace;
  meId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const trash = useWorkspaceTrash(workspace.id, open);
  const restore = useRestoreBase(workspace.id);
  const purge = usePurgeBase(workspace.id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one clock per opening.
  const now = useMemo(() => Date.now(), [open]);
  const role = workspace.role ?? undefined;
  const items = trash.data?.bases.map((b) => ({
    key: b.id,
    name: b.name,
    icon: <DatabaseIcon />,
    deletedAt: b.deletedAt,
    deletedBy: b.deletedBy,
    purgeAfter: b.purgeAfter,
    target: { kind: 'table' as const, id: b.id },
  }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Trash of {workspace.name}</DialogTitle>
          <DialogDescription>
            Deleted bases stay here for 30 days, with everything in them.
          </DialogDescription>
        </DialogHeader>
        <CollaboratorsProvider workspaceId={open ? workspace.id : undefined} meId={meId}>
          <TrashList
            label="Deleted bases"
            items={items}
            loading={trash.isPending}
            empty="No deleted bases."
            now={now}
            // Restoring and purging a base are both for the workspace's creators and owners.
            canRestore={canPurge(role)}
            canPurge={canPurge(role)}
            busy={restore.isPending || purge.isPending}
            onRestore={(item) =>
              restore.mutate(item.key, {
                onSuccess: () => toast.success(`Restored "${item.name}"`),
                onError: (err) => toast.error(message(err, `Couldn't restore "${item.name}"`)),
              })
            }
            onPurge={(item) => {
              if (!confirmPurge(item.name)) return;
              purge.mutate(item.key, {
                onSuccess: () => toast.success(`Deleted "${item.name}" permanently`),
                onError: (err) => toast.error(message(err, `Couldn't delete "${item.name}"`)),
              });
            }}
          />
        </CollaboratorsProvider>
      </DialogContent>
    </Dialog>
  );
}

function TrashList({
  label,
  items,
  loading,
  empty,
  now,
  canRestore,
  canPurge,
  busy,
  onRestore,
  onPurge,
}: {
  label: string;
  items: Item[] | undefined;
  loading: boolean;
  empty: string;
  now: number;
  canRestore: boolean;
  canPurge: boolean;
  busy: boolean;
  onRestore: (item: Item) => void;
  onPurge: (item: Item) => void;
}) {
  if (loading) {
    return (
      <div className="grid gap-2" aria-busy="true">
        <Skeleton className="h-11" />
        <Skeleton className="h-11" />
      </div>
    );
  }
  if (!items?.length) return <p className="py-6 text-center text-text-2">{empty}</p>;
  return (
    <ul aria-label={label} className="-mx-2 grid min-h-0 overflow-y-auto">
      {items.map((item) => {
        const status = purgeStatus(item.purgeAfter, now);
        return (
          <li
            key={item.key}
            className="flex items-center gap-3 rounded-sm px-2 py-1.5 hover:bg-hover max-sm:flex-wrap"
          >
            <span className="text-text-2 [&_svg]:size-4" aria-hidden>
              {item.icon}
            </span>
            <span className="grid min-w-0 flex-1">
              <span className="truncate font-[550]">{item.name}</span>
              <span className="flex min-w-0 items-center gap-1 text-small text-text-2">
                {item.where && <span className="shrink-0">{item.where} ·</span>}
                <span className="shrink-0">Deleted {deletedAgo(item.deletedAt, now)}</span>
                {item.deletedBy && (
                  <>
                    <span className="shrink-0">by</span>
                    <UserChip userId={item.deletedBy} />
                  </>
                )}
              </span>
            </span>
            <span
              className={cn(
                'shrink-0 text-small',
                status.due ? 'font-[550] text-danger' : 'text-text-2'
              )}
            >
              {status.label}
            </span>
            {canRestore && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onRestore(item)}
                aria-label={`Restore ${item.name}`}
              >
                <RotateCcwIcon />
                Restore
              </Button>
            )}
            {canPurge && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onPurge(item)}
                aria-label={`Delete ${item.name} permanently`}
                title="Delete permanently"
              >
                <Trash2Icon />
                <span className="sr-only sm:not-sr-only">Delete</span>
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
