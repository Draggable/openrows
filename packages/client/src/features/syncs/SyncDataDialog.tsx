import {
  type Base,
  SYNC_SCHEDULES,
  SYNC_SOURCE_KINDS,
  type SyncSchedule,
  type SyncSourceKind,
  syncedTypeOf,
  type TableMeta,
} from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  baseQueries,
  tableQueries,
  useCreateSync,
  useSyncConnectors,
  useSyncMutations,
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
import {
  canSyncBothWays,
  defaultTargets,
  SCHEDULE_LABELS,
  SOURCE_KIND_LABELS,
  type SourceCopy,
  TWO_WAY_HELP,
  targetChoices,
} from './model';

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/**
 * "Sync data" under the base sidebar's tables (creators and up): pick a table, and
 * optionally one of its views, from any base you can read (in any of your workspaces), and how
 * often it syncs. The new table is synced one way: its records follow the source. A table or view
 * source can also sync both ways ("Sync both ways", off by default; the server checks the caller
 * can edit the source and that no loop forms).
 *
 * With `addTo`, "Add a source" of that synced table (creators and up): the same source picker,
 * then where each of the source's fields (or columns) goes: an existing synced field of a fitting
 * type, or a new field. The source's records stay its own.
 */
export function SyncDataDialog({
  base,
  addTo,
  open,
  onOpenChange,
}: {
  base: Base;
  /** The synced table a source is added to; none: a new synced table. */
  addTo?: TableMeta | undefined;
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
  const [twoWay, setTwoWay] = useState(false);
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
  const { addSource } = useSyncMutations(addTo?.id ?? '');
  const [keyFieldId, setKeyFieldId] = useState('');
  const [targets, setTargets] = useState<Record<string, string | null>>({});
  const ids = {
    kind: useId(),
    workspace: useId(),
    base: useId(),
    table: useId(),
    view: useId(),
    schedule: useId(),
    name: useId(),
    key: useId(),
    twoWayHelp: useId(),
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
  // Adding a source: the source table's fields, for the key and the mapping.
  const sourceTable = useQuery({
    ...tableQueries.detail(chosenTable ?? ''),
    enabled: open && !!addTo && kind === 'table' && !!chosenTable,
  });
  const sourceFields = (kind === 'table' && sourceTable.data?.fields) || [];
  const copies = useMemo<SourceCopy[]>(() => {
    if (!addTo) return [];
    if (kind === 'table') {
      const all = sourceTable.data?.fields ?? [];
      return [...all.filter((f) => f.isPrimary), ...all.filter((f) => !f.isPrimary)].map((f) => ({
        ref: f.id,
        name: f.name,
        type: syncedTypeOf(f.type),
      }));
    }
    return (draft?.columns ?? []).map((c) => ({ ref: c.name, name: c.name, type: c.type }));
  }, [addTo, kind, sourceTable.data, draft]);
  // New copies (another source, a column's type changed): the default mapping again.
  const copiesKey = JSON.stringify(copies);
  useEffect(() => {
    if (addTo) setTargets(defaultTargets(JSON.parse(copiesKey) as SourceCopy[], addTo.fields));
  }, [copiesKey, addTo]);

  useEffect(() => {
    if (!open) return;
    setWorkspaceId(base.workspaceId);
    setSourceBaseId(undefined);
    setTableId(undefined);
    setViewId('');
    setSchedule('hourly');
    setTwoWay(false);
    setName('');
    setDraft(null);
    setKeyFieldId('');
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

  const ready =
    (kind === 'table' ? !!chosenTable : draft !== null) && (!addTo || copies.length > 0);
  const submitAdd = () => {
    if (!addTo) return;
    const mapped = copies.map((c) =>
      kind === 'table'
        ? { sourceFieldId: c.ref, fieldId: targets[c.ref] ?? null }
        : { column: c.ref, fieldId: targets[c.ref] ?? null }
    );
    let body: Parameters<typeof addSource.mutate>[0];
    if (kind === 'table') {
      if (!chosenBase || !chosenTable) return;
      body = {
        source: { baseId: chosenBase, tableId: chosenTable, viewId: viewId || null },
        keyFieldId: keyFieldId || null,
        schedule,
        ...(twoWay ? { twoWay } : {}),
        targets: mapped,
      };
    } else {
      if (!draft) return;
      body = { ...draft, schedule, targets: mapped };
    }
    addSource.mutate(body, {
      onSuccess: () => {
        toast.success('Source added');
        onOpenChange(false);
      },
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : "Couldn't add the source"),
    });
  };
  const submit = () => {
    if (addTo) {
      submitAdd();
      return;
    }
    const named = name.trim() ? { name: name.trim() } : {};
    let body: Parameters<typeof create.mutate>[0];
    if (kind === 'table') {
      if (!chosenBase || !chosenTable) return;
      body = {
        ...named,
        source: { baseId: chosenBase, tableId: chosenTable, viewId: viewId || null },
        schedule,
        ...(twoWay ? { twoWay } : {}),
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
            <DialogTitle>{addTo ? 'Add a source' : 'Sync data'}</DialogTitle>
            <DialogDescription>
              {addTo
                ? `Adds a source to ${addTo.name}. Its records sync beside the ones already there and stay its own: the same key from two sources makes two records.`
                : `Adds a table to ${base.name} whose records follow a table or view you can read, a CSV file, a database or a connected app. Synced fields are read-only here; fields you add stay editable.`}
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
          {addTo && kind === 'table' && sourceFields.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={ids.key} className="text-small text-text-2">
                Match records by
              </label>
              <select
                id={ids.key}
                className={selectClass}
                value={keyFieldId}
                onChange={(e) => setKeyFieldId(e.target.value)}
              >
                <option value="">The source record</option>
                {sourceFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {addTo && copies.length > 0 && (
            <FieldMapping
              copies={copies}
              fields={addTo.fields}
              targets={targets}
              onChange={(ref, fieldId) => setTargets((t) => ({ ...t, [ref]: fieldId }))}
            />
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
          {canSyncBothWays(kind) && (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-body text-text">
                <input
                  type="checkbox"
                  checked={twoWay}
                  onChange={(e) => setTwoWay(e.target.checked)}
                  aria-describedby={ids.twoWayHelp}
                  className="size-4 accent-[var(--accent)]"
                />
                <span>Sync both ways</span>
              </label>
              <p id={ids.twoWayHelp} className="pl-6 text-small text-text-2">
                {TWO_WAY_HELP} You need to be able to edit the source's records.
              </p>
            </div>
          )}
          {!addTo && (
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
          )}
          {kind === 'table' && bases.isSuccess && !tableList.length && !tables.isPending && (
            <p className="text-small text-text-2">No table you can sync in this base.</p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {addTo ? (
              <Button type="submit" disabled={addSource.isPending || !ready}>
                {addSource.isPending ? 'Adding…' : 'Add source'}
              </Button>
            ) : (
              <Button type="submit" disabled={create.isPending || !ready}>
                {create.isPending ? 'Adding…' : 'Sync table'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where a new source's fields (or columns) go on the synced table: an existing synced field
 * that takes their values as they are (the same type, or text), or a new field.
 */
function FieldMapping({
  copies,
  fields,
  targets,
  onChange,
}: {
  copies: readonly SourceCopy[];
  fields: TableMeta['fields'];
  targets: Record<string, string | null>;
  onChange: (ref: string, fieldId: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="max-h-56 overflow-auto rounded-sm border border-border">
        <table className="w-full text-small">
          <caption className="sr-only">Where the source's fields go</caption>
          <thead className="sticky top-0 bg-header text-left text-text-2">
            <tr>
              <th className="px-2 py-1 font-medium">Source</th>
              <th className="px-2 py-1 font-medium">Into</th>
            </tr>
          </thead>
          <tbody>
            {copies.map((copy) => {
              const taken = new Set(
                Object.entries(targets)
                  .filter(([ref, id]) => ref !== copy.ref && id)
                  .map(([, id]) => id)
              );
              const choices = targetChoices(copy, fields).filter((f) => !taken.has(f.id));
              return (
                <tr key={copy.ref} className="border-t border-border">
                  <td className="max-w-[180px] truncate px-2 py-1">{copy.name}</td>
                  <td className="px-2 py-1">
                    <select
                      aria-label={`${copy.name} goes into`}
                      className="h-7 w-full rounded-sm border border-border bg-surface px-1 text-small"
                      value={targets[copy.ref] ?? ''}
                      onChange={(e) => onChange(copy.ref, e.target.value || null)}
                    >
                      <option value="">A new field</option>
                      {choices.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-small text-text-2">
        A source field goes into a field of the same type, a text field, or a new field.
      </p>
    </div>
  );
}
