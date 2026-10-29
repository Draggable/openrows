import type { Base } from '@openrows/shared';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import { useDuplicateBase, useDuplicateJob, useWorkspaces } from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
  toast,
} from '../../components/ui';
import { copyName, progressLabel, targetWorkspaces } from './model';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/**
 * "Duplicate base" from the base menu (creators and up): the copy's name, the workspace it
 * goes to (any where the person is a creator) and whether the records come along. The copy runs
 * in the worker; its job is polled with its progress, then the copy opens.
 */
export function DuplicateBaseDialog({
  base,
  open,
  onOpenChange,
}: {
  base: Base;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const workspaces = useWorkspaces();
  const targets = targetWorkspaces(workspaces.data?.workspaces ?? []);
  const [name, setName] = useState(copyName(base.name));
  const [workspaceId, setWorkspaceId] = useState<string | undefined>();
  const [withRecords, setWithRecords] = useState(true);
  const [running, setRunning] = useState<string | undefined>();
  const start = useDuplicateBase(base.id);
  const job = useDuplicateJob(base.id, running);
  const nameId = useId();
  const workspaceFieldId = useId();
  const target =
    workspaceId ??
    (targets.some((w) => w.id === base.workspaceId) ? base.workspaceId : targets[0]?.id);
  const busy = start.isPending || running !== undefined;

  useEffect(() => {
    if (open) setName(copyName(base.name));
  }, [open, base.name]);
  useEffect(() => {
    const data = job.data;
    if (!running || !data || data.id !== running || data.status === 'running') return;
    setRunning(undefined);
    if (data.status === 'done' && data.base) {
      toast.success(`Duplicated to "${data.base.name}"`);
      onOpenChange(false);
      navigate({ to: '/b/$baseId', params: { baseId: data.base.id } });
    } else {
      toast.error(data.error ?? "Couldn't duplicate the base");
    }
  }, [job.data, running, navigate, onOpenChange]);
  useEffect(() => {
    if (!running || !job.isError) return;
    setRunning(undefined);
    toast.error(message(job.error, "Couldn't duplicate the base"));
  }, [job.isError, job.error, running]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || !target) return;
    start.mutate(
      { name: trimmed, workspaceId: target, withRecords },
      {
        onSuccess: (started) => setRunning(started.id),
        onError: (err) => toast.error(message(err, "Couldn't duplicate the base")),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Duplicate base</DialogTitle>
            <DialogDescription>
              Copies the tables, fields, views, forms and automations of {base.name}. Automations
              start turned off and ask for their secrets again. Share links, webhooks,
              collaborators, comments and other people's personal views stay here.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-small text-text-2">
              Name
            </label>
            <Input
              id={nameId}
              value={name}
              maxLength={255}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={workspaceFieldId} className="text-small text-text-2">
              Workspace
            </label>
            <select
              id={workspaceFieldId}
              className={selectClass}
              value={target ?? ''}
              disabled={busy || !targets.length}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              {targets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {workspaces.isSuccess && !targets.length && (
              <p className="text-small text-text-2">
                You need to be a creator of a workspace to add a base to it.
              </p>
            )}
          </div>
          <label className="flex items-center gap-2 text-text">
            <input
              type="checkbox"
              checked={withRecords}
              disabled={busy}
              onChange={(e) => setWithRecords(e.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            <span>Copy records, links and attachments</span>
          </label>
          <DialogFooter className="items-center">
            {running !== undefined && (
              <span role="status" className="mr-auto flex items-center gap-2 text-text-2">
                <Spinner size="sm" />
                {progressLabel(job.data)}
              </span>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {running ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !target}>
              {busy ? 'Duplicating…' : 'Duplicate base'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
