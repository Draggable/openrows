import { type Base, MAX_SNAPSHOT_RETENTION_DAYS, type Snapshot } from '@openrows/shared';
import { useNavigate } from '@tanstack/react-router';
import { CameraIcon, HistoryIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  useDeleteSnapshot,
  useRestoreJob,
  useRestoreSnapshot,
  useSnapshots,
  useTakeSnapshot,
  useUpdateSnapshotSettings,
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
import { canManageSnapshots, canSetRetention, KIND_LABELS, snapshotSummary } from './model';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * A base's snapshots (creators and up, from the base menu): "Snapshot now", the list with
 * what each holds, "Restore to a new base" (never over this one) and delete; owners set how
 * long the workspace keeps them.
 */
export function SnapshotsDialog({
  base,
  open,
  onOpenChange,
}: {
  base: Base;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const list = useSnapshots(base.id, open);
  const take = useTakeSnapshot(base.id);
  const restore = useRestoreSnapshot(base.id);
  const remove = useDeleteSnapshot(base.id);
  const settings = useUpdateSnapshotSettings(base.workspaceId, base.id);
  const [days, setDays] = useState<string | null>(null);
  const daysId = useId();
  const manage = canManageSnapshots(base.role);
  const retention = list.data?.retentionDays;
  // A restore runs in the worker: its job is polled until the new base exists.
  const [restoring, setRestoring] = useState<{ id: string; snapshotId: string } | undefined>();
  const job = useRestoreJob(base.id, restoring?.id);
  const busy = take.isPending || restore.isPending || remove.isPending || restoring !== undefined;

  useEffect(() => {
    const data = job.data;
    if (!restoring || !data || data.id !== restoring.id || data.status === 'running') return;
    setRestoring(undefined);
    if (data.status === 'done' && data.base) {
      toast.success(`Restored to "${data.base.name}"`);
      onOpenChange(false);
      navigate({ to: '/b/$baseId', params: { baseId: data.base.id } });
    } else {
      toast.error(data.error ?? "Couldn't restore the snapshot");
    }
  }, [job.data, restoring, navigate, onOpenChange]);
  useEffect(() => {
    if (!restoring || !job.isError) return;
    setRestoring(undefined);
    toast.error(message(job.error, "Couldn't restore the snapshot"));
  }, [job.isError, job.error, restoring]);

  const onTake = () =>
    take.mutate(undefined, {
      onSuccess: () => toast.success('Snapshot taken'),
      onError: (err) => toast.error(message(err, "Couldn't take a snapshot")),
    });
  const onRestore = (s: Snapshot) =>
    restore.mutate(
      { snapshotId: s.id },
      {
        onSuccess: (started) => setRestoring({ id: started.id, snapshotId: s.id }),
        onError: (err) => toast.error(message(err, "Couldn't restore the snapshot")),
      }
    );
  const onDelete = (s: Snapshot) => {
    if (!window.confirm(`Delete the snapshot of ${when(s.createdAt)}? This can't be undone.`)) {
      return;
    }
    remove.mutate(s.id, {
      onSuccess: () => toast.success('Snapshot deleted'),
      onError: (err) => toast.error(message(err, "Couldn't delete the snapshot")),
    });
  };
  const onSaveDays = () => {
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > MAX_SNAPSHOT_RETENTION_DAYS) {
      toast.error(`Keep snapshots for 1 to ${MAX_SNAPSHOT_RETENTION_DAYS} days.`);
      return;
    }
    settings.mutate(value, {
      onSuccess: () => {
        setDays(null);
        toast.success(`Snapshots are kept for ${value} days`);
      },
      onError: (err) => toast.error(message(err, "Couldn't change the retention")),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Snapshots</DialogTitle>
          <DialogDescription>
            Point-in-time copies of {base.name}
            {retention ? `, kept for ${retention} days` : ''}. Bases that changed get one
            automatically every day. Restoring makes a new base; this one stays as it is.
          </DialogDescription>
        </DialogHeader>
        {manage && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
            <Button onClick={onTake} disabled={busy}>
              <CameraIcon />
              {take.isPending ? 'Taking snapshot…' : 'Snapshot now'}
            </Button>
            {canSetRetention(base.role) && retention !== undefined && (
              <div className="flex items-center gap-2 text-small text-text-2">
                <label htmlFor={daysId}>Keep for</label>
                <Input
                  id={daysId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_SNAPSHOT_RETENTION_DAYS}
                  className="h-8 w-20"
                  value={days ?? String(retention)}
                  onChange={(e) => setDays(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSaveDays();
                  }}
                />
                days
                {days !== null && days !== String(retention) && (
                  <Button size="sm" variant="ghost" onClick={onSaveDays}>
                    Save
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
        <div className="min-h-[160px] flex-1 overflow-y-auto">
          {list.isPending ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : list.isError ? (
            <p className="py-6 text-center text-text-2">
              {message(list.error, "Couldn't load the snapshots.")}
            </p>
          ) : !list.data.snapshots.length ? (
            <p className="py-6 text-center text-text-2">
              No snapshots yet. Take one now, or wait for the daily snapshot.
            </p>
          ) : (
            <ul aria-label="Snapshots" className="flex flex-col divide-y divide-border">
              {list.data.snapshots.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-2">
                  <HistoryIcon className="size-4 shrink-0 text-text-2" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-[550]">{when(s.createdAt)}</span>
                      <span className="rounded-xs border border-border px-1 text-small text-text-2">
                        {KIND_LABELS[s.kind]}
                      </span>
                    </div>
                    <div className="truncate text-small text-text-2">
                      {snapshotSummary(s)} · until{' '}
                      {new Date(s.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                    </div>
                  </div>
                  {manage && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => onRestore(s)}
                        aria-label={`Restore the snapshot of ${when(s.createdAt)} to a new base`}
                      >
                        {restoring?.snapshotId === s.id ? 'Restoring…' : 'Restore to new base'}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onDelete(s)}
                        aria-label={`Delete the snapshot of ${when(s.createdAt)}`}
                      >
                        <Trash2Icon />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
