import { type FieldMeta, type FieldTypeName, getFieldType } from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { recordQueries } from '../../api/queries';
import { cn } from '../../lib/utils';
import { conversionPreview } from './model';

/** Records the preview samples (one page of the view query). */
export const PREVIEW_SAMPLE = 100;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "3 values will be cleared and 2 values will change". */
function lossSummary(cleared: number, changed: number): string {
  const parts = [];
  if (cleared > 0) parts.push(`${plural(cleared, 'value')} will be cleared`);
  if (changed > 0) parts.push(`${plural(changed, 'value')} will change`);
  return parts.join(' and ');
}

/**
 * How the field's values would convert to a new type or options, from the registry's
 * `convertValue` (the rule the server applies) over the first records of the table. Warns when
 * values would be cleared or changed: a type change rewrites the column and can't be undone.
 */
export function ConversionPreview({
  field,
  type,
  options,
}: {
  field: FieldMeta;
  type: FieldTypeName;
  options: Record<string, unknown>;
}) {
  const sample = useQuery(
    recordQueries.query(field.tableId, { query: { fields: [field.id] }, limit: PREVIEW_SAMPLE })
  );
  // Links: their options change no values, and a conversion into one matches records of
  // the linked table by primary field on the server, which the registry can't preview.
  if (getFieldType(type).storage.kind === 'link') {
    if (field.type === type) return null;
    return (
      <p className="text-small text-text-2">
        Values will link to the records of the chosen table whose primary field matches them
        (separate several with commas). Names that match no record become new records there.
      </p>
    );
  }
  if (sample.isPending) {
    return <p className="text-small text-text-2">Checking how the values convert…</p>;
  }
  if (sample.isError) {
    return <p className="text-small text-text-2">Couldn't load values to preview.</p>;
  }
  const values = sample.data.records.map((r) => r.fields[field.id]);
  const preview = conversionPreview(
    { type: field.type, options: field.options },
    { type, options },
    values
  );
  const total = sample.data.total ?? values.length;
  const scope =
    total > values.length
      ? `in the first ${values.length.toLocaleString()} of ${plural(total, 'record')}`
      : `in ${plural(total, 'record')}`;
  const lossy = preview.cleared > 0 || preview.changed > 0;
  const typeChanged = type !== field.type;
  if (!typeChanged && !lossy) return null;

  return (
    <section aria-label="Conversion preview" className="grid gap-2">
      {preview.sampled === 0 ? (
        <p className="text-small text-text-2">No values to convert {scope}.</p>
      ) : lossy ? (
        <div
          role="alert"
          className="flex gap-2 rounded-sm border border-border bg-header p-2 text-small text-text"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" aria-hidden />
          <p>
            {preview.computedTarget
              ? `${getFieldType(type).label} fills its own values: ${plural(preview.cleared, 'value')} ${scope} will be discarded.`
              : `${lossSummary(preview.cleared, preview.changed)} ${scope}.`}{' '}
            This can't be undone.
          </p>
        </div>
      ) : (
        <p className="text-small text-text-2">
          All {plural(preview.sampled, 'value')} {scope} convert without loss.
        </p>
      )}
      {preview.examples.length > 0 && (
        <ul aria-label="Examples" className="grid gap-1 text-small">
          {preview.examples.map((ex, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: examples have no identity
              key={i}
              className="grid grid-cols-[1fr_auto_1fr] items-center gap-2"
            >
              <span className="truncate text-text-2" title={ex.before}>
                {ex.before}
              </span>
              <ArrowRight className="size-3.5 text-text-3" aria-label="becomes" />
              <span
                className={cn('truncate', ex.cleared ? 'text-danger italic' : 'text-text')}
                title={ex.after || 'Empty'}
              >
                {ex.cleared ? 'Empty' : ex.after}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
