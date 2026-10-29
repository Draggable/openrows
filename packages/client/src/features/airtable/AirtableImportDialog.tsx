import {
  type AirtableBase,
  type AirtableImport,
  MAX_AIRTABLE_BASES_PER_IMPORT,
} from '@openrows/shared';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  useAirtableBases,
  useAirtableImports,
  useCancelAirtableImport,
  useStartAirtableImport,
} from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
  toast,
} from '../../components/ui';
import { watchImports } from './AirtableImportWatcher';
import {
  eta,
  hasReportLines,
  importCounts,
  importProgress,
  looksLikeToken,
  plural,
  reportSummary,
} from './model';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/**
 * "Import from Airtable" (workspace creators): paste an Airtable personal access token,
 * pick bases, and each becomes a new base the worker fills. The token lives in this dialog's
 * state only until the import starts (the server keeps it encrypted for the job, never shows it
 * again). Below, the imports you started here: a progress bar with the tables, records,
 * files and links so far and the time left, Cancel, then the report and a link to the base. A
 * toast says when one ends, wherever you are (AirtableImportWatcher).
 */
export function AirtableImportDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [token, setToken] = useState('');
  const [bases, setBases] = useState<AirtableBase[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const find = useAirtableBases(workspaceId);
  const start = useStartAirtableImport(workspaceId);
  const imports = useAirtableImports(workspaceId, open);
  const tokenId = useId();
  const hintId = useId();

  const reset = () => {
    setToken('');
    setBases(null);
    setPicked([]);
  };
  const onFind = () =>
    find.mutate(token.trim(), {
      onSuccess: (list) => {
        setBases(list.bases);
        setPicked([]);
      },
      onError: (err) => toast.error(message(err, "Couldn't reach Airtable")),
    });
  const onStart = () =>
    start.mutate(
      { token: token.trim(), baseIds: picked },
      {
        onSuccess: (res) => {
          toast.success(`Importing ${plural(res.imports.length, 'base')}`);
          watchImports(res.imports.map((i) => ({ id: i.id, workspaceId })));
          reset();
        },
        onError: (err) => toast.error(message(err, "Couldn't start the import")),
      }
    );
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const full = picked.length >= MAX_AIRTABLE_BASES_PER_IMPORT;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Import from Airtable</DialogTitle>
          <DialogDescription>
            Each Airtable base becomes a new base here: tables, fields, records with their linked
            records and attachments, and the grid and kanban views.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
          {bases === null ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (looksLikeToken(token)) onFind();
              }}
            >
              <label htmlFor={tokenId} className="block font-medium">
                Airtable personal access token
              </label>
              <Input
                id={tokenId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="pat…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                aria-describedby={hintId}
              />
              <p id={hintId} className="text-small text-text-2">
                Create one at{' '}
                <a
                  href="https://airtable.com/create/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  airtable.com/create/tokens
                </a>{' '}
                with the scopes <code>data.records:read</code> and <code>schema.bases:read</code>.
                It is only used for this import and deleted when it ends.
              </p>
              <Button type="submit" disabled={!looksLikeToken(token) || find.isPending}>
                {find.isPending ? 'Finding bases…' : 'Find bases'}
              </Button>
            </form>
          ) : (
            <section aria-labelledby={`${tokenId}-bases`} className="space-y-2">
              <h3 id={`${tokenId}-bases`} className="font-medium">
                Pick the bases to import
                <span className="ml-2 text-small font-normal text-text-2">
                  up to {MAX_AIRTABLE_BASES_PER_IMPORT} at a time
                </span>
              </h3>
              {bases.length === 0 ? (
                <p className="text-text-2">The token can't read any base.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {bases.map((b) => {
                    const checked = picked.includes(b.id);
                    return (
                      <li key={b.id}>
                        <label className="flex h-[34px] cursor-pointer items-center gap-2 px-3 hover:bg-hover">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!checked && full}
                            onChange={() => toggle(b.id)}
                            className="accent-primary"
                          />
                          <span className="flex-1 truncate">{b.name}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex gap-2">
                <Button onClick={onStart} disabled={picked.length === 0 || start.isPending}>
                  {start.isPending
                    ? 'Starting…'
                    : picked.length
                      ? `Import ${plural(picked.length, 'base')}`
                      : 'Import'}
                </Button>
                <Button variant="ghost" onClick={reset}>
                  Use another token
                </Button>
              </div>
            </section>
          )}
          <ImportList workspaceId={workspaceId} imports={imports.data?.imports ?? []} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImportList({ workspaceId, imports }: { workspaceId: string; imports: AirtableImport[] }) {
  const cancel = useCancelAirtableImport(workspaceId);
  const running = imports.some((i) => i.status === 'running');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (imports.length === 0) return null;
  return (
    <section aria-label="Your Airtable imports" className="space-y-2">
      <h3 className="font-medium">Your imports</h3>
      <ul className="space-y-2">
        {imports.map((i) => (
          <ImportItem
            key={i.id}
            item={i}
            now={now}
            cancelling={cancel.isPending && cancel.variables === i.id}
            onCancel={() =>
              cancel.mutate(i.id, {
                onSuccess: () => toast(`Cancelled the import of ${i.name}`),
                onError: (err) => toast.error(message(err, "Couldn't cancel the import")),
              })
            }
          />
        ))}
      </ul>
    </section>
  );
}

function ImportItem({
  item,
  now,
  cancelling,
  onCancel,
}: {
  item: AirtableImport;
  now: number;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const summary = reportSummary(item.report);
  const r = item.report;
  const running = item.status === 'running';
  const left = eta(item, now);
  const labelId = useId();
  return (
    <li className="rounded-md border border-border p-3" aria-busy={running}>
      <div className="flex items-center gap-2">
        {running && <Spinner size="sm" />}
        <span id={labelId} className="flex-1 truncate font-medium">
          {item.name}
        </span>
        {running && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </Button>
        )}
        {item.status !== 'failed' && (
          <Link
            to="/b/$baseId"
            params={{ baseId: item.baseId }}
            className="text-small text-primary underline"
          >
            Open base
          </Link>
        )}
      </div>
      {running && (
        <div className="mt-2 space-y-1">
          <div
            role="progressbar"
            aria-labelledby={labelId}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={item.percent}
            aria-valuetext={`${item.percent}%`}
            className="h-1.5 overflow-hidden rounded-full bg-hover"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${item.percent}%` }}
            />
          </div>
          <p className="flex flex-wrap gap-x-3 text-small text-text-2 tabular-nums">
            <span>{item.percent}%</span>
            {importCounts(item).map((c) => (
              <span key={c}>{c}</span>
            ))}
            {left && <span>{left}</span>}
          </p>
        </div>
      )}
      <p className="text-small text-text-2" role="status">
        {importProgress(item)}
        {item.status === 'done' && summary.length ? ` · ${summary.join(' · ')}` : ''}
      </p>
      {item.error && (
        <p
          className={
            item.status === 'cancelled' ? 'text-small text-text-2' : 'text-small text-danger'
          }
        >
          {item.error}
        </p>
      )}
      {item.status !== 'running' && hasReportLines(r) && (
        <details className="mt-1 text-small">
          <summary className="cursor-pointer text-text-2">Import report</summary>
          <ReportLines title="Left out" lines={r.unsupportedFields} />
          <ReportLines
            title="Formulas kept as text"
            lines={r.untranslatedFormulas.map((f) => ({
              ...f,
              message: `${f.message} (${f.formula})`,
            }))}
          />
          <ReportLines title="Changed type" lines={r.converted} />
          <ReportLines
            title="Files not copied"
            lines={r.failedAttachments.map((f) => ({
              table: f.table,
              field: f.field,
              type: f.filename,
              message: f.message,
            }))}
          />
          <ReportLines
            title="Views not imported"
            lines={r.unsupportedViews.map((v) => ({
              table: v.table,
              field: v.view,
              type: v.type,
              message: v.message,
            }))}
          />
          {r.skippedLinks > 0 && (
            <p className="mt-2">
              {plural(r.skippedLinks, 'link')} to records that weren't imported (or past 1,000 in a
              cell) were skipped.
            </p>
          )}
          {r.truncatedTables.length > 0 && (
            <p className="mt-2">
              Tables cut short at 100,000 records: {r.truncatedTables.join(', ')}
            </p>
          )}
          <p className="mt-2 text-text-2">
            Airtable's API doesn't share views' filters, sorts or groups: set them again here.
          </p>
        </details>
      )}
    </li>
  );
}

function ReportLines({
  title,
  lines,
}: {
  title: string;
  lines: { table: string; field: string; type: string; message: string }[];
}) {
  if (!lines.length) return null;
  return (
    <div className="mt-2">
      <p className="font-medium">{title}</p>
      <ul className="list-disc pl-5 text-text-2">
        {lines.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: report lines can repeat a field.
          <li key={`${l.table}.${l.field}.${i}`}>
            {l.table} › {l.field} ({l.type}): {l.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
