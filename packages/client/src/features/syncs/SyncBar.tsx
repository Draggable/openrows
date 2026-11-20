import {
  type Base,
  MAX_SYNC_SOURCES_PER_TABLE,
  SYNC_SCHEDULES,
  type SyncSchedule,
  type TableMeta,
  type TableSync,
  type UserRole,
} from '@openrows/shared';
import { RefreshCwIcon, SettingsIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { ApiError } from '../../api/client';
import { useSyncMutations, useTableSources } from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from '../../components/ui';
import { cn } from '../../lib/utils';
import {
  canSyncBothWays,
  isBusy,
  runSummary,
  SCHEDULE_LABELS,
  SOURCE_KIND_LABELS,
  sourceLine,
  sourcesStatusLine,
  statusLine,
  TWO_WAY_HELP,
} from './model';
import { SyncDataDialog } from './SyncDataDialog';

const failed = (what: string) => (err: unknown) =>
  toast.error(err instanceof ApiError ? err.message : `Couldn't ${what}`);

const selectClass =
  'h-7 rounded-sm border border-border bg-surface px-1 text-small text-text hover:border-border-strong';

/**
 * A synced table's header strip: where its records come from, when it last synced (or
 * why it's paused), "Sync now" for editors and up, and the sync's settings for creators
 * (schedule, pause or resume, add a source, stop syncing). A table with several sources says
 * how many, and "Sources" lists each one with its own status, schedule, "Sync now", pause and
 * removal. A table or view source can be switched to "Sync both ways" (and back) there or in the
 * settings menu. Ledger: neutral fill; a paused sync gets the banner's 2 px top accent, never a
 * coloured left border.
 */
export function SyncBar({
  table,
  base,
  role,
}: {
  table: TableMeta;
  base: Base | undefined;
  role: UserRole | undefined;
}) {
  const list = useTableSources(table.id, table.synced === true);
  const { run, update, remove } = useSyncMutations(table.id);
  const [adding, setAdding] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const sources = list.data?.sources ?? [];
  const [s] = sources;
  if (!table.synced || !s) return null;
  const several = sources.length > 1;
  const paused = several ? sources.every((x) => x.status === 'paused') : s.status === 'paused';
  const anyPaused = sources.some((x) => x.status === 'paused');
  const busy = sources.some((x) => isBusy(x)) || run.isPending;
  const canRun = role === 'owner' || role === 'creator' || role === 'editor';
  const canAdd = s.canManage && sources.length < MAX_SYNC_SOURCES_PER_TABLE && !!base;
  const last = s.runs.find((r) => r.status === 'succeeded');
  const setTwoWay = (source: TableSync, on: boolean) => {
    if (on && !window.confirm(`Sync both ways with ${source.source.label}? ${TWO_WAY_HELP}`)) {
      return;
    }
    update.mutate(
      { twoWay: on },
      {
        onSuccess: () =>
          toast.success(on ? 'The table now syncs both ways' : 'The table now syncs one way'),
        onError: failed(on ? 'sync both ways' : 'sync one way'),
      }
    );
  };
  const stop = () => {
    if (
      !window.confirm(
        several
          ? `Stop syncing this table from all ${sources.length} sources? It keeps its records as an ordinary, editable table.`
          : 'Stop syncing this table? It keeps its records as an ordinary, editable table.'
      )
    ) {
      return;
    }
    remove.mutate(undefined, {
      onSuccess: () => toast.success('The table is no longer synced'),
      onError: failed('stop syncing'),
    });
  };
  return (
    <div
      role="status"
      data-testid="sync-bar"
      data-state={paused ? 'paused' : busy ? 'syncing' : 'idle'}
      className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border bg-header px-3 py-1.5 text-small md:px-6',
        anyPaused && 'border-t-2 border-t-warning'
      )}
    >
      <RefreshCwIcon
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          anyPaused ? 'text-[var(--warning)]' : 'text-text-2',
          busy && 'animate-spin motion-reduce:animate-none'
        )}
      />
      <p className="min-w-0 flex-1 truncate text-text-2">
        {several ? (
          <>
            <span className="text-text">Synced from {sources.length} sources</span>
            <span aria-hidden> · </span>
            <span>{sourcesStatusLine(sources)}</span>
          </>
        ) : (
          <>
            <span className="text-text">{sourceLine(s)}</span>
            <span aria-hidden> · </span>
            <span>{statusLine(s)}</span>
            {!paused && !busy && last && (
              <span className="max-md:hidden">
                <span aria-hidden> · </span>
                {runSummary(last)}
              </span>
            )}
          </>
        )}
      </p>
      {several && (
        <Button size="sm" variant="ghost" onClick={() => setShowSources(true)}>
          Sources
        </Button>
      )}
      {paused && s.canManage && (
        <Button
          size="sm"
          variant="secondary"
          disabled={update.isPending}
          onClick={() => update.mutate({ paused: false }, { onError: failed('resume the sync') })}
        >
          Resume
        </Button>
      )}
      {!paused && canRun && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => run.mutate(undefined, { onError: failed('sync the table') })}
        >
          {busy ? 'Syncing…' : 'Sync now'}
        </Button>
      )}
      {s.canManage && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Sync settings">
              <SettingsIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel>Sync</DropdownMenuLabel>
            {!several &&
              SYNC_SCHEDULES.map((schedule) => (
                <DropdownMenuCheckboxItem
                  key={schedule}
                  checked={s.schedule === schedule}
                  onCheckedChange={() =>
                    update.mutate({ schedule }, { onError: failed('change the schedule') })
                  }
                >
                  {SCHEDULE_LABELS[schedule]}
                </DropdownMenuCheckboxItem>
              ))}
            {!several && canSyncBothWays(s.source.kind) && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={s.twoWay}
                  title={TWO_WAY_HELP}
                  onCheckedChange={(on) => setTwoWay(s, on === true)}
                >
                  Sync both ways
                </DropdownMenuCheckboxItem>
              </>
            )}
            {several && (
              <DropdownMenuItem onSelect={() => setShowSources(true)}>
                Manage sources…
              </DropdownMenuItem>
            )}
            {canAdd && (
              <DropdownMenuItem onSelect={() => setAdding(true)}>Add a source…</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {!paused && (
              <DropdownMenuItem
                onSelect={() =>
                  update.mutate({ paused: true }, { onError: failed('pause the sync') })
                }
              >
                {several ? 'Pause all sources' : 'Pause syncing'}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="text-danger" onSelect={stop}>
              Stop syncing
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {base && adding && (
        <SyncDataDialog base={base} addTo={table} open={adding} onOpenChange={setAdding} />
      )}
      {several && (
        <SyncSourcesDialog
          table={table}
          sources={sources}
          canRun={canRun}
          open={showSources}
          onOpenChange={setShowSources}
          onAdd={canAdd ? () => setAdding(true) : undefined}
        />
      )}
    </div>
  );
}

/**
 * "Sources": each source of the table with its status and last run; editors sync one now,
 * creators change its schedule, pause or resume it, or remove it (its records stay).
 */
function SyncSourcesDialog({
  table,
  sources,
  canRun,
  open,
  onOpenChange,
  onAdd,
}: {
  table: TableMeta;
  sources: readonly TableSync[];
  canRun: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (() => void) | undefined;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Sources of {table.name}</DialogTitle>
          <DialogDescription>
            Each source syncs its own records on its own schedule: the same key from two sources
            makes two records. Removing a source keeps its records, which no source updates any
            more.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col divide-y divide-border rounded-sm border border-border">
          {sources.map((source) => (
            <SourceRow key={source.id} tableId={table.id} source={source} canRun={canRun} />
          ))}
        </ul>
        {onAdd && (
          <div>
            <Button
              variant="secondary"
              onClick={() => {
                onOpenChange(false);
                onAdd();
              }}
            >
              Add a source
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SourceRow({
  tableId,
  source,
  canRun,
}: {
  tableId: string;
  source: TableSync;
  canRun: boolean;
}) {
  const { runSource, updateSource, removeSource } = useSyncMutations(tableId);
  const scheduleId = useId();
  const paused = source.status === 'paused';
  const busy = isBusy(source);
  const last = source.runs.find((r) => r.status !== 'queued' && r.status !== 'running');
  const label = source.source.label || SOURCE_KIND_LABELS[source.source.kind];
  const update = (
    body: { schedule?: SyncSchedule; paused?: boolean; twoWay?: boolean },
    what: string
  ) => updateSource.mutate({ syncId: source.id, body }, { onError: failed(what) });
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2" data-testid="sync-source">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body text-text">
          {label}
          {source.twoWay && <span className="text-small text-text-2"> · both ways</span>}
        </span>
        {!paused && canRun && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => runSource.mutate(source.id, { onError: failed('sync the source') })}
          >
            {busy ? 'Syncing…' : 'Sync now'}
          </Button>
        )}
        {paused && source.canManage && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => update({ paused: false }, 'resume the source')}
          >
            Resume
          </Button>
        )}
      </div>
      <p className="text-small text-text-2">
        {statusLine(source)}
        {!paused && !busy && last && last.status === 'succeeded' && ` · ${runSummary(last)}`}
      </p>
      {source.canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={scheduleId} className="sr-only">
            Schedule of {label}
          </label>
          <select
            id={scheduleId}
            className={selectClass}
            value={source.schedule}
            onChange={(e) =>
              update({ schedule: e.target.value as SyncSchedule }, 'change the schedule')
            }
          >
            {SYNC_SCHEDULES.map((schedule) => (
              <option key={schedule} value={schedule}>
                {SCHEDULE_LABELS[schedule]}
              </option>
            ))}
          </select>
          {!paused && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => update({ paused: true }, 'pause the source')}
            >
              Pause
            </Button>
          )}
          {canSyncBothWays(source.source.kind) && (
            <label className="flex items-center gap-1.5 text-small text-text" title={TWO_WAY_HELP}>
              <input
                type="checkbox"
                checked={source.twoWay}
                onChange={(e) => {
                  const on = e.target.checked;
                  if (on && !window.confirm(`Sync both ways with ${label}? ${TWO_WAY_HELP}`))
                    return;
                  update({ twoWay: on }, on ? 'sync both ways' : 'sync one way');
                }}
                className="size-4 accent-[var(--accent)]"
              />
              Both ways
            </label>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-danger"
            disabled={removeSource.isPending}
            onClick={() => {
              if (
                !window.confirm(
                  `Remove ${label}? Its records stay in the table, and no source updates them any more.`
                )
              ) {
                return;
              }
              removeSource.mutate(source.id, {
                onSuccess: () => toast.success('Source removed'),
                onError: failed('remove the source'),
              });
            }}
          >
            Remove
          </Button>
        </div>
      )}
    </li>
  );
}
