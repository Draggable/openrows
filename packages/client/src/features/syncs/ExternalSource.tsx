import {
  type ExternalSyncSource,
  getFieldType,
  SYNC_COLUMN_TYPES,
  type SyncColumn,
  type SyncColumnType,
  type SyncConnectorInfo,
  type SyncPreview,
} from '@openrows/shared';
import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import { usePreviewSync } from '../../api/queries';
import { Button, Input } from '../../components/ui';
import { cn } from '../../lib/utils';
import { type ConnectorChoice, ConnectorPicker } from './ConnectorPicker';
import { type ColumnChoice, columnChoices, columnsBody, suggestedKey } from './model';

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/** What the dialog sends for an external source once it's previewed and mapped. */
export interface ExternalDraft {
  source: ExternalSyncSource;
  columns: SyncColumn[];
  keyColumn: string | null;
}

/**
 * The "Sync data" dialog's CSV URL and Postgres sources: the URL or the connection string
 * (and a table or a SELECT query), "Preview", then the mapping: which columns sync, each one's
 * field type, and the key column that matches rows to records (or the row number). Editing the
 * source drops the preview. The URL and connection string are sent once and never shown again.
 * : a sync connector's source (a Google sheet) is picked with ConnectorPicker instead.
 */
export function ExternalSource({
  baseId,
  kind,
  connector,
  onDraft,
}: {
  baseId: string;
  kind: 'csv' | 'postgres' | 'connector';
  /** the sync connector, for kind `connector`. */
  connector?: SyncConnectorInfo | undefined;
  onDraft: (draft: ExternalDraft | null) => void;
}) {
  const [url, setUrl] = useState('');
  const [connection, setConnection] = useState('');
  const [mode, setMode] = useState<'table' | 'query'>('table');
  const [table, setTable] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ConnectorChoice>({ path: [], headerRow: 1 });
  const [preview, setPreview] = useState<{ source: ExternalSyncSource; data: SyncPreview }>();
  const [choices, setChoices] = useState<ColumnChoice[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const run = usePreviewSync(baseId);
  const ids = { url: useId(), conn: useId(), what: useId(), key: useId(), error: useId() };

  const source: ExternalSyncSource =
    kind === 'connector'
      ? {
          kind,
          connector: connector?.id ?? '',
          path: picked.path.map((p) => p.id),
          headerRow: picked.headerRow,
        }
      : kind === 'csv'
        ? { kind, url: url.trim() }
        : {
            kind,
            connectionString: connection.trim(),
            ...(mode === 'table' ? { table: table.trim() } : { query: query.trim() }),
          };
  const filled =
    kind === 'connector'
      ? !!connector && picked.path.length === connector.levels.length
      : kind === 'csv'
        ? url.trim() !== ''
        : connection.trim() !== '' && (mode === 'table' ? table.trim() : query.trim()) !== '';

  // A changed source needs a new preview.
  const sourceKey = JSON.stringify(source);
  const previewed = preview && JSON.stringify(preview.source) === sourceKey;
  useEffect(() => {
    if (!previewed) {
      onDraft(null);
      return;
    }
    const body = columnsBody(choices, key);
    onDraft(body.columns.length ? { source: preview.source, ...body } : null);
  }, [previewed, preview, choices, key, onDraft]);

  const doPreview = () => {
    setError(undefined);
    run.mutate(
      { source },
      {
        onSuccess: (data) => {
          setPreview({ source, data });
          setChoices(columnChoices(data));
          setKey(suggestedKey(data.columns));
        },
        onError: (err) => {
          setPreview(undefined);
          setError(err instanceof ApiError ? err.message : "Couldn't read the source.");
        },
      }
    );
  };

  const setChoice = (i: number, patch: Partial<ColumnChoice>) =>
    setChoices((all) => all.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const included = choices.filter((c) => c.include);

  return (
    <div className="flex flex-col gap-3">
      {kind === 'connector' ? (
        connector && (
          <ConnectorPicker
            baseId={baseId}
            connector={connector}
            value={picked}
            onChange={setPicked}
          />
        )
      ) : kind === 'csv' ? (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.url} className="text-small text-text-2">
            CSV URL
          </label>
          <Input
            id={ids.url}
            type="url"
            value={url}
            placeholder="https://example.com/export.csv"
            maxLength={2048}
            autoComplete="off"
            aria-describedby={error ? ids.error : undefined}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.conn} className="text-small text-text-2">
              Connection string
            </label>
            <Input
              id={ids.conn}
              type="password"
              value={connection}
              placeholder="postgres://reader:password@db.example.com:5432/crm"
              maxLength={2048}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={error ? ids.error : undefined}
              onChange={(e) => setConnection(e.target.value)}
            />
            <p className="text-small text-text-2">
              Use a role that can only read. Kept encrypted; TLS unless you add sslmode=disable
              where allowed.
            </p>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-small text-text-2">Read</legend>
            <div className="flex gap-4 text-body">
              {(['table', 'query'] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    className="accent-[var(--accent)]"
                    name={ids.what}
                    checked={mode === m}
                    onChange={() => setMode(m)}
                  />
                  {m === 'table' ? 'A table' : 'A SELECT query'}
                </label>
              ))}
            </div>
            {mode === 'table' ? (
              <Input
                aria-label="Table"
                value={table}
                placeholder="public.customers"
                maxLength={127}
                spellCheck={false}
                onChange={(e) => setTable(e.target.value)}
              />
            ) : (
              <textarea
                aria-label="SELECT query"
                value={query}
                rows={3}
                maxLength={10_000}
                spellCheck={false}
                placeholder="SELECT id, name, email FROM customers WHERE active"
                className="rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-small text-text hover:border-border-strong"
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
          </fieldset>
        </>
      )}
      <div
        className={cn(
          'flex items-center gap-2',
          kind === 'connector' && !connector?.account && 'hidden'
        )}
      >
        <Button
          type="button"
          variant="secondary"
          disabled={!filled || run.isPending}
          onClick={doPreview}
        >
          {run.isPending ? 'Reading…' : previewed ? 'Preview again' : 'Preview'}
        </Button>
        {previewed && <span className="truncate text-small text-text-2">{preview.data.label}</span>}
      </div>
      {error && (
        <p id={ids.error} role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      {previewed && (
        <div className="flex flex-col gap-2">
          <div className="max-h-56 overflow-auto rounded-sm border border-border">
            <table className="w-full text-small">
              <caption className="sr-only">Columns to sync</caption>
              <thead className="sticky top-0 bg-header text-left text-text-2">
                <tr>
                  <th className="px-2 py-1 font-medium">Column</th>
                  <th className="px-2 py-1 font-medium">Field type</th>
                  <th className="px-2 py-1 font-medium">First value</th>
                </tr>
              </thead>
              <tbody>
                {choices.map((c, i) => (
                  <tr key={c.name} className="border-t border-border">
                    <td className="px-2 py-1">
                      <label className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--accent)]"
                          checked={c.include}
                          onChange={(e) => setChoice(i, { include: e.target.checked })}
                        />
                        <span className="truncate">{c.name}</span>
                      </label>
                    </td>
                    <td className="px-2 py-1">
                      <select
                        aria-label={`${c.name} field type`}
                        className="h-7 w-full rounded-sm border border-border bg-surface px-1 text-small"
                        value={c.type}
                        disabled={!c.include}
                        onChange={(e) =>
                          setChoice(i, { type: e.target.value as SyncColumnType, options: {} })
                        }
                      >
                        {SYNC_COLUMN_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {getFieldType(t).label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="max-w-[120px] truncate px-2 py-1 text-text-2">
                      {preview.data.rows[0]?.[i] ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={ids.key} className="text-small text-text-2">
              Match rows by
            </label>
            <select
              id={ids.key}
              className={selectClass}
              value={key ?? ''}
              onChange={(e) => setKey(e.target.value || null)}
            >
              <option value="">Row number</option>
              {included.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {!included.length && (
            <p className="text-small text-text-2">Pick at least one column to sync.</p>
          )}
        </div>
      )}
    </div>
  );
}
