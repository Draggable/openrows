import { type FieldMeta, type FieldTypeName, getFieldType, type TableMeta } from '@openrows/shared';
import { FileUp } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ApiError } from '../../api/client';
import { useImportJob, useStartImport } from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from '../../components/ui';
import {
  type ColumnPlan,
  type ColumnTarget,
  dataRows,
  importableTypes,
  importBody,
  mappingErrors,
  planColumns,
  readCsv,
  writableFields,
} from './model';

const selectClass =
  'h-7 rounded-sm border border-border bg-surface px-1.5 text-body hover:bg-hover disabled:opacity-60';

interface Picked {
  name: string;
  text: string;
  rows: string[][];
}

/**
 * CSV import: pick a file, check the preview, map each column to an existing field, a new
 * field (with the inferred type, changeable) or nothing, then the import runs on the server and
 * the dialog shows its progress. Creating fields needs a creator; editors map to existing ones.
 */
export function ImportDialog({
  table,
  open,
  onOpenChange,
  canCreateFields,
  initialFile,
}: {
  table: TableMeta;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canCreateFields: boolean;
  /** A file already picked (Home's "Import a file"): the dialog opens on its preview. */
  initialFile?: File | undefined;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [addOptions, setAddOptions] = useState(true);
  const [plans, setPlans] = useState<ColumnPlan[]>([]);
  const [importId, setImportId] = useState<string | undefined>();
  const start = useStartImport(table.id);
  const job = useImportJob(table.id, importId);
  const fileInputId = useId();

  const reset = () => {
    setPicked(null);
    setError(null);
    setPlans([]);
    setImportId(undefined);
    setHasHeader(true);
    setAddOptions(true);
  };
  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const text = await file.text();
    const read = readCsv(text, file.size);
    if (!read.ok) {
      setError(read.error);
      return;
    }
    setPicked({ name: file.name, text, rows: read.rows });
    setPlans(planColumns(read.rows, hasHeader, table.fields, canCreateFields));
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reads the file once per open
  useEffect(() => {
    if (open && initialFile) void pick(initialFile);
  }, [open, initialFile]);

  const toggleHeader = (next: boolean) => {
    setHasHeader(next);
    if (picked) setPlans(planColumns(picked.rows, next, table.fields, canCreateFields));
  };

  const setTarget = (index: number, target: ColumnTarget) =>
    setPlans((ps) => ps.map((p) => (p.index === index ? { ...p, target } : p)));

  const errors = mappingErrors(plans, table.fields);
  const submit = () => {
    if (!picked || errors.size > 0) return;
    const typecast = canCreateFields && addOptions;
    start.mutate(importBody(picked.text, picked.rows, hasHeader, plans, typecast), {
      onSuccess: (j) => setImportId(j.id),
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : "Couldn't start the import."),
    });
  };

  const current = job.data;
  const finished = current && current.status !== 'running' ? current : undefined;
  // Finished: report once and close.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per finished job
  useEffect(() => {
    if (!finished) return;
    if (finished.status === 'done') {
      const skipped = finished.skippedCells
        ? ` ${finished.skippedCells.toLocaleString()} cells couldn't be read and were left empty.`
        : '';
      toast.success(`Imported ${finished.processedRows.toLocaleString()} records.${skipped}`);
    } else {
      toast.error(
        `The import stopped after ${finished.processedRows.toLocaleString()} records: ${finished.error ?? 'unknown error'}`
      );
    }
    close(false);
  }, [finished?.id]);

  const rowCount = picked ? dataRows(picked.rows, hasHeader).length : 0;
  const running = importId !== undefined;
  const progress = current && current.totalRows > 0 ? current.processedRows / current.totalRows : 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !running && close(next)}>
      <DialogContent className="max-w-3xl" aria-describedby={`${fileInputId}-desc`}>
        <DialogHeader>
          <DialogTitle>Import CSV into {table.name}</DialogTitle>
          <DialogDescription id={`${fileInputId}-desc`}>
            Up to 50 MB. Each row becomes a record; choose where each column goes.
          </DialogDescription>
        </DialogHeader>

        {!picked && (
          <label
            htmlFor={fileInputId}
            className="flex h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-border border-dashed text-text-2 hover:bg-hover"
          >
            <FileUp className="size-5" aria-hidden />
            <span>Choose a CSV file</span>
            <input
              id={fileInputId}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
              className="sr-only"
              onChange={(e) => void pick(e.target.files?.[0])}
            />
          </label>
        )}

        {picked && !running && (
          <div className="flex min-h-0 flex-col gap-3">
            <div className="flex items-center justify-between gap-3 text-text-2">
              <span className="truncate">
                <span className="text-text">{picked.name}</span> · {rowCount.toLocaleString()}{' '}
                {rowCount === 1 ? 'row' : 'rows'}
              </span>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => toggleHeader(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                First row is the header
              </label>
            </div>
            {canCreateFields && (
              <label className="flex items-center gap-2 text-text-2">
                <input
                  type="checkbox"
                  checked={addOptions}
                  onChange={(e) => setAddOptions(e.target.checked)}
                  className="accent-[var(--accent)]"
                />
                Add missing options to select fields
              </label>
            )}
            <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
              <table className="w-full border-collapse text-body" aria-label="Column mapping">
                <thead className="sticky top-0 bg-header text-left text-text-2">
                  <tr>
                    <th className="w-40 px-2 py-1.5 font-medium">Column</th>
                    <th className="px-2 py-1.5 font-medium">Preview</th>
                    <th className="w-64 px-2 py-1.5 font-medium">Import into</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.map((p) => (
                    <ColumnRow
                      key={p.index}
                      plan={p}
                      fields={table.fields}
                      canCreateFields={canCreateFields}
                      error={errors.get(p.index)}
                      onChange={(t) => setTarget(p.index, t)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {running && (
          <div className="flex flex-col gap-2 py-4" aria-live="polite">
            <div
              role="progressbar"
              aria-label="Import progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress * 100)}
              className="h-2 overflow-hidden rounded-full bg-hover"
            >
              <div className="h-full bg-primary" style={{ width: `${progress * 100}%` }} />
            </div>
            <p className="tnum text-text-2">
              {current
                ? `${current.processedRows.toLocaleString()} of ${current.totalRows.toLocaleString()} rows imported`
                : 'Starting the import…'}
            </p>
          </div>
        )}

        {(error ?? errors.get(-1)) && picked && !running && (
          <p role="alert" className="text-danger">
            {error ?? errors.get(-1)}
          </p>
        )}
        {error && !picked && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}

        <DialogFooter>
          {picked && !running && (
            <Button variant="ghost" onClick={reset}>
              Choose another file
            </Button>
          )}
          <Button variant="ghost" onClick={() => close(false)} disabled={running}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!picked || running || start.isPending || errors.size > 0}
          >
            {rowCount > 0
              ? `Import ${rowCount.toLocaleString()} ${rowCount === 1 ? 'record' : 'records'}`
              : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SKIP = 'skip';
const NEW = 'new';

function ColumnRow({
  plan,
  fields,
  canCreateFields,
  error,
  onChange,
}: {
  plan: ColumnPlan;
  fields: FieldMeta[];
  canCreateFields: boolean;
  error: string | undefined;
  onChange: (t: ColumnTarget) => void;
}) {
  const { target } = plan;
  const value = target.kind === 'field' ? target.fieldId : target.kind;
  const label = `Import column ${plan.header} into`;
  return (
    <tr className="border-border border-t align-top">
      <td className="px-2 py-1.5 font-medium">
        <span className="block truncate" title={plan.header}>
          {plan.header}
        </span>
      </td>
      <td className="px-2 py-1.5 text-text-2">
        <span className="line-clamp-2 break-all" title={plan.sample.join(', ')}>
          {plan.sample.filter((s) => s.trim() !== '').join(', ') || '—'}
        </span>
      </td>
      <td className="flex flex-col gap-1 px-2 py-1.5">
        <select
          aria-label={label}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v === SKIP) onChange({ kind: 'skip' });
            else if (v === NEW)
              onChange({ kind: 'new', name: plan.header, type: plan.inferred.type });
            else onChange({ kind: 'field', fieldId: v });
          }}
          className={`${selectClass} w-full`}
        >
          <option value={SKIP}>Don't import</option>
          {canCreateFields && <option value={NEW}>New field</option>}
          {writableFields(fields).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {target.kind === 'new' && (
          <div className="flex gap-1">
            <input
              aria-label={`Name of the new field for ${plan.header}`}
              value={target.name}
              onChange={(e) => onChange({ ...target, name: e.target.value })}
              className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-surface px-1.5 text-body"
            />
            <select
              aria-label={`Type of the new field for ${plan.header}`}
              value={target.type}
              onChange={(e) => onChange({ ...target, type: e.target.value as FieldTypeName })}
              className={`${selectClass} w-32 shrink-0`}
            >
              {importableTypes().map((t) => (
                <option key={t} value={t}>
                  {getFieldType(t).label}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && <span className="text-danger text-small">{error}</span>}
      </td>
    </tr>
  );
}
