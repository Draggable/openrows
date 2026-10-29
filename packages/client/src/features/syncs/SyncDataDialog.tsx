import {
  type Base,
  SYNC_SCHEDULES,
  SYNC_SOURCE_KINDS,
  type SyncSchedule,
  type SyncSourceKind,
} from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  baseQueries,
  tableQueries,
  useCreateSync,
  useSyncConnectors,
  useWorkspaces,
  viewQueries,
} from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  toast,
} from '../../components/ui';
import { type ExternalDraft, ExternalSource } from './ExternalSource';
import { SCHEDULE_LABELS, SOURCE_KIND_LABELS } from './model';

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/**
 * "Sync data" under the base sidebar's tables (creators and up): pick a table, and
 * optionally one of its views, from any base you can read (in any of your workspaces), and how
 * often it syncs. The new table is synced one way: its records follow the source.
 */
export function SyncDataDialog({
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
  const [workspaceId, setWorkspaceId] = useState(base.workspaceId);
  const [sourceBaseId, setSourceBaseId] = useState<string | undefined>();
  const [tableId, setTableId] = useState<string | undefined>();
  const [viewId, setViewId] = useState('');
  const [schedule, setSchedule] = useState<SyncSchedule>('hourly');
  const [name, setName] = useState('');
  // a CSV URL or a Postgres database instead of a table: an edition's connector
  // (`connector:<id>`, e.g. Google Sheets) when the instance has one.
  const [choice, setChoice] = useState<string>('table');
  const connectors = useSyncConnectors(open);
  const connector = choice.startsWith('connector:')
    ? connectors.data?.find((c) => `connector:${c.id}` === choice)
    : undefined;
  const kind: SyncSourceKind = choice.startsWith('connector:')
    ? 'connector'
    : (choice as SyncSourceKind);
  const [draft, setDraft] = useState<ExternalDraft | null>(null);
  const onDraft = useCallback((d: ExternalDraft | null) => setDraft(d), []);
  const create = useCreateSync(base.id);
  const ids = {
    kind: useId(),
    workspace: useId(),
    base: useId(),
    table: useId(),
    view: useId(),
    schedule: useId(),
    name: useId(),
  };

  const bases = useQuery({ ...baseQueries.list(workspaceId), enabled: open });
  const baseList = bases.data?.bases ?? [];
  const chosenBase = sourceBaseId ?? baseList[0]?.id;
  const tables = useQuery({
    ...tableQueries.list(chosenBase ?? ''),
    enabled: open && !!chosenBase,
  });
  // A synced table can't be a source.
  const tableList = (tables.data?.tables ?? []).filter((t) => !t.synced);
  const chosenTable = tableId ?? tableList[0]?.id;
  const views = useQuery({
    ...viewQueries.list(chosenTable ?? ''),
    enabled: open && !!chosenTable,
  });
  const viewList = (views.data?.views ?? []).filter((v) => v.type !== 'form');
  const sourceName = tableList.find((t) => t.id === chosenTable)?.name ?? '';

  useEffect(() => {
    if (!open) return;
    setWorkspaceId(base.workspaceId);
    setSourceBaseId(undefined);
    setTableId(undefined);
    setViewId('');
    setSchedule('hourly');
    setName('');
    setDraft(null);
    // Back from a connector's consent page: that connector, and the outcome.
    const params = new URLSearchParams(window.location.search);
    const back = params.get('syncConnector');
    setChoice(back ? `connector:${back}` : 'table');
    if (back) {
      if (params.get('connected') === '0') toast.error("Couldn't connect the account");
      params.delete('syncConnector');
      params.delete('connected');
      const rest = params.toString();
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`
      );
    }
  }, [open, base.workspaceId]);

  const ready = kind === 'table' ? !!chosenTable : draft !== null;
  const submit = () => {
    const named = name.trim() ? { name: name.trim() } : {};
    let body: Parameters<typeof create.mutate>[0];
    if (kind === 'table') {
      if (!chosenBase || !chosenTable) return;
      body = {
        ...named,
        source: { baseId: chosenBase, tableId: chosenTable, viewId: viewId || null },
        schedule,
      };
    } else {
      if (!draft) return;
      body = { ...named, ...draft, schedule };
    }
    create.mutate(body, {
      onSuccess: (sync) => {
        toast.success('Syncing the table');
        onOpenChange(false);
        navigate({
          to: '/b/$baseId/$tableId',
          params: { baseId: base.id, tableId: sync.tableId },
        });
      },
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : "Couldn't sync the table"),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Sync data</DialogTitle>
            <DialogDescription>
              Adds a table to {base.name} whose records follow a table or view you can read, a CSV
              file, a database or a connected app. Synced fields are read-only here; fields you add
              stay editable.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.kind} className="text-small text-text-2">
              Source
            </label>
            <select
              id={ids.kind}
              className={selectClass}
              value={choice}
              onChange={(e) => {
                setChoice(e.target.value);
                setDraft(null);
              }}
            >
              {SYNC_SOURCE_KINDS.filter((k) => k !== 'connector').map((k) => (
                <option key={k} value={k}>
                  {SOURCE_KIND_LABELS[k]}
                </option>
              ))}
              {connectors.data?.map((c) => (
                <option key={c.id} value={`connector:${c.id}`}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {kind === 'connector' && !connector ? (
            <p className="text-small text-text-2">
              {connectors.isPending ? 'Loading…' : "This source isn't available on this server."}
            </p>
          ) : kind !== 'table' ? (
            <ExternalSource
              key={choice}
              baseId={base.id}
              kind={kind}
              connector={connector}
              onDraft={onDraft}
            />
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.workspace} className="text-small text-text-2">
                  Workspace
                </label>
                <select
                  id={ids.workspace}
                  className={selectClass}
                  value={workspaceId}
                  onChange={(e) => {
                    setWorkspaceId(e.target.value);
                    setSourceBaseId(undefined);
                    setTableId(undefined);
                    setViewId('');
                  }}
                >
                  {(workspaces.data?.workspaces ?? []).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={ids.base} className="text-small text-text-2">
                  Base
                </label>
                <select
                  id={ids.base}
                  className={selectClass}
                  value={chosenBase ?? ''}
                  disabled={!baseList.length}
                  onChange={(e) => {
                    setSourceBaseId(e.target.value);
                    setTableId(undefined);
                    setViewId('');
                  }}
                >
                  {baseList.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.table} className="text-small text-text-2">
                    Table
                  </label>
                  <select
                    id={ids.table}
                    className={selectClass}
                    value={chosenTable ?? ''}
                    disabled={!tableList.length}
                    onChange={(e) => {
                      setTableId(e.target.value);
                      setViewId('');
                    }}
                  >
                    {tableList.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={ids.view} className="text-small text-text-2">
                    Records
                  </label>
                  <select
                    id={ids.view}
                    className={selectClass}
                    value={viewId}
                    disabled={!chosenTable}
                    onChange={(e) => setViewId(e.target.value)}
                  >
                    <option value="">All records</option>
                    {viewList.map((v) => (
                      <option key={v.id} value={v.id}>
                        In view {v.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.schedule} className="text-small text-text-2">
              Sync
            </label>
            <select
              id={ids.schedule}
              className={selectClass}
              value={schedule}
              onChange={(e) => setSchedule(e.target.value as SyncSchedule)}
            >
              {SYNC_SCHEDULES.map((s) => (
                <option key={s} value={s}>
                  {SCHEDULE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.name} className="text-small text-text-2">
              Table name
            </label>
            <Input
              id={ids.name}
              value={name}
              placeholder={(kind === 'table' && sourceName) || 'Same as the source'}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {kind === 'table' && bases.isSuccess && !tableList.length && !tables.isPending && (
            <p className="text-small text-text-2">No table you can sync in this base.</p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !ready}>
              {create.isPending ? 'Adding…' : 'Sync table'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
