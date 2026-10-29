import { SYNC_SCHEDULES, type TableMeta, type UserRole } from '@openrows/shared';
import { RefreshCwIcon, SettingsIcon } from 'lucide-react';
import { ApiError } from '../../api/client';
import { useSyncMutations, useTableSync } from '../../api/queries';
import {
  Button,
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
import { isBusy, runSummary, SCHEDULE_LABELS, statusLine } from './model';

const failed = (what: string) => (err: unknown) =>
  toast.error(err instanceof ApiError ? err.message : `Couldn't ${what}`);

/**
 * A synced table's header strip: where its records come from, when it last synced (or
 * why it's paused), "Sync now" for editors and up, and the sync's settings for creators
 * (schedule, pause or resume, stop syncing). Ledger: neutral fill; a paused sync gets the
 * banner's 2 px top accent, never a coloured left border.
 */
export function SyncBar({ table, role }: { table: TableMeta; role: UserRole | undefined }) {
  const sync = useTableSync(table.id, table.synced === true);
  const { run, update, remove } = useSyncMutations(table.id);
  if (!table.synced || !sync.data) return null;
  const s = sync.data;
  const paused = s.status === 'paused';
  const busy = isBusy(s) || run.isPending;
  const canRun = role === 'owner' || role === 'creator' || role === 'editor';
  const last = s.runs.find((r) => r.status === 'succeeded');
  return (
    <div
      role="status"
      data-testid="sync-bar"
      data-state={paused ? 'paused' : busy ? 'syncing' : 'idle'}
      className={cn(
        'flex shrink-0 items-center gap-2 border-b border-border bg-header px-3 py-1.5 text-small md:px-6',
        paused && 'border-t-2 border-t-warning'
      )}
    >
      <RefreshCwIcon
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          paused ? 'text-[var(--warning)]' : 'text-text-2',
          busy && 'animate-spin motion-reduce:animate-none'
        )}
      />
      <p className="min-w-0 flex-1 truncate text-text-2">
        <span className="text-text">Synced from {s.source.label || 'another table'}</span>
        <span aria-hidden> · </span>
        <span>{statusLine(s)}</span>
        {!paused && !busy && last && (
          <span className="max-md:hidden">
            <span aria-hidden> · </span>
            {runSummary(last)}
          </span>
        )}
      </p>
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
            {SYNC_SCHEDULES.map((schedule) => (
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
            <DropdownMenuSeparator />
            {!paused && (
              <DropdownMenuItem
                onSelect={() =>
                  update.mutate({ paused: true }, { onError: failed('pause the sync') })
                }
              >
                Pause syncing
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              className="text-danger"
              onSelect={() => {
                if (
                  !window.confirm(
                    'Stop syncing this table? It keeps its records as an ordinary, editable table.'
                  )
                ) {
                  return;
                }
                remove.mutate(undefined, {
                  onSuccess: () => toast.success('The table is no longer synced'),
                  onError: failed('stop syncing'),
                });
              }}
            >
              Stop syncing
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
