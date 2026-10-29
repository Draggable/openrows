import {
  type FieldMeta,
  type FormField,
  type FormLayout,
  visibleFormFields,
} from '@openrows/shared';
import { useMemo, useState } from 'react';
import { MadeWith } from '../../../app/Logo';
import { Button, Input, toast } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { fileUrl } from '../../attachments/upload';
import { choicesOf, editorKind, fieldDef, parseInput } from '../../grid/cells/model';
import { RichText } from '../../grid/cells/RichText';
import { selectClass } from '../toolbar/FilterMenu';
import { formEntries, labelOf } from './model';

/** What the preview's inputs hold, as typed (numbers stay text until read). */
type Answers = Record<string, unknown>;

/** The answers as values the conditions read: numbers parsed as the field reads them. */
export function valuesOf(answers: Answers, fields: readonly FieldMeta[]): Answers {
  const out: Answers = {};
  for (const f of fields) {
    const raw = answers[f.id];
    if (raw === undefined) continue;
    const kind = editorKind(f);
    out[f.id] =
      typeof raw === 'string' && (kind === 'number' || kind === 'duration')
        ? parseInput(f, raw)
        : raw;
  }
  return out;
}

/**
 * The live preview of a form: the cover, logo, title, description and the fields as a
 * submitter sees them, with inputs that work, so conditional fields appear and disappear as
 * the answers above them change. Nothing is submitted.
 */
export function FormPreview({
  layout,
  fields,
  tableId,
  fallbackTitle,
  selectedId,
  onSelect,
}: {
  layout: FormLayout;
  fields: readonly FieldMeta[];
  tableId: string;
  fallbackTitle: string;
  selectedId: string | null;
  onSelect: (fieldId: string) => void;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const entries = formEntries(layout, fields);
  const values = useMemo(() => valuesOf(answers, fields), [answers, fields]);
  const shown = new Set(
    visibleFormFields(
      entries.map((e) => e.entry),
      values,
      fields
    ).map((e) => e.fieldId)
  );
  const hidden = entries.length - shown.size;
  const set = (fieldId: string, value: unknown) => setAnswers((a) => ({ ...a, [fieldId]: value }));
  const title = layout.title?.trim() || fallbackTitle;

  return (
    <section
      aria-label="Form preview"
      className="min-w-0 flex-1 overflow-y-auto bg-app px-6 py-8 max-sm:px-3 max-sm:py-4"
    >
      <div className="mx-auto max-w-[640px] overflow-hidden rounded-lg border border-border bg-surface shadow-1">
        {layout.coverAttachmentId && (
          <img
            src={fileUrl(tableId, layout.coverAttachmentId)}
            alt=""
            className="h-40 w-full object-cover"
            data-testid="form-cover"
          />
        )}
        <div className="grid gap-6 p-8 max-sm:p-5">
          <header className="grid gap-2">
            {layout.logoAttachmentId && (
              <img
                src={fileUrl(tableId, layout.logoAttachmentId)}
                alt="Logo"
                className="h-12 w-auto max-w-[200px] object-contain object-left"
              />
            )}
            <h2 className="text-title font-semibold">{title}</h2>
            {layout.description?.trim() && (
              <RichText text={layout.description} links={false} className="text-text-2" />
            )}
          </header>
          <form
            aria-label={title}
            className="grid gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              toast("This is a preview: answers aren't saved.");
            }}
          >
            {entries.length === 0 && (
              <p className="text-text-2">Add fields from the list to build the form.</p>
            )}
            {entries.map(({ entry, field }) =>
              shown.has(field.id) ? (
                <PreviewField
                  key={field.id}
                  entry={entry}
                  field={field}
                  value={answers[field.id]}
                  selected={selectedId === field.id}
                  onSelect={() => onSelect(field.id)}
                  onChange={(v) => set(field.id, v)}
                />
              ) : null
            )}
            {hidden > 0 && (
              <p className="text-small text-text-2" data-testid="form-hidden-count">
                {hidden === 1
                  ? '1 field shows when its conditions match.'
                  : `${hidden} fields show when their conditions match.`}
              </p>
            )}
            <div>
              <Button type="submit">{layout.submitLabel?.trim() || 'Submit'}</Button>
            </div>
          </form>
        </div>
      </div>
      {layout.showBranding !== false && (
        <p className="mt-4 text-center">
          <MadeWith />
        </p>
      )}
    </section>
  );
}

function PreviewField({
  entry,
  field,
  value,
  selected,
  onSelect,
  onChange,
}: {
  entry: FormField;
  field: FieldMeta;
  value: unknown;
  selected: boolean;
  onSelect: () => void;
  onChange: (value: unknown) => void;
}) {
  const id = `form-preview-${field.id}`;
  const label = labelOf(entry, field);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click picks the field in the builder; the list is the keyboard path
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      data-testid="form-preview-field"
      data-field-id={field.id}
      onClick={onSelect}
      className={cn('-mx-3 grid gap-1.5 rounded-md px-3 py-2', selected && 'bg-selected')}
    >
      <label htmlFor={id} className="font-[550]">
        {label}
        {entry.required && (
          <span className="ml-0.5 text-danger" aria-hidden>
            *
          </span>
        )}
        {entry.required && <span className="sr-only"> (required)</span>}
      </label>
      {entry.helpText?.trim() && (
        <RichText text={entry.helpText} links={false} className="text-small text-text-2" />
      )}
      <PreviewInput
        id={id}
        field={field}
        value={value}
        onChange={onChange}
        required={!!entry.required}
      />
    </div>
  );
}

export function PreviewInput({
  id,
  field,
  value,
  required,
  onChange,
}: {
  id: string;
  field: FieldMeta;
  value: unknown;
  required: boolean;
  onChange: (value: unknown) => void;
}) {
  const kind = editorKind(field);
  const text = typeof value === 'string' ? value : '';
  const common = { id, required, 'aria-required': required || undefined };
  switch (kind) {
    case 'longText':
      return (
        <textarea
          {...common}
          rows={4}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-body hover:border-border-strong focus-visible:border-brand focus-visible:outline-none"
        />
      );
    case 'checkbox':
      return (
        <input
          {...common}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 accent-[var(--accent)]"
        />
      );
    case 'singleSelect':
      return (
        <select
          {...common}
          value={text}
          onChange={(e) => onChange(e.target.value || null)}
          className={cn(selectClass, 'h-8 w-full')}
        >
          <option value="">Pick an option…</option>
          {choicesOf(field).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      );
    case 'multipleSelect': {
      const picked = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset id={id} className="flex flex-wrap gap-1" aria-label={field.name}>
          {choicesOf(field).map((c) => {
            const on = picked.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? picked.filter((x) => x !== c.id) : [...picked, c.id])}
                className={cn(
                  'h-7 rounded-sm border border-border px-2 text-small hover:bg-hover',
                  on && 'border-primary bg-selected text-primary'
                )}
              >
                {c.name}
              </button>
            );
          })}
        </fieldset>
      );
    }
    case 'rating': {
      const max = (fieldDef(field).options as { max?: number }).max ?? 5;
      return (
        <select
          {...common}
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
          className={cn(selectClass, 'h-8 w-32')}
        >
          <option value="">No rating</option>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      );
    }
    case 'date':
    case 'dateTime':
      return (
        <Input
          {...common}
          type={kind === 'date' ? 'date' : 'datetime-local'}
          value={text}
          onChange={(e) => onChange(e.target.value || null)}
          className="w-56"
        />
      );
    case 'user':
    case 'link':
    case 'attachment':
      return (
        <div
          id={id}
          className="flex h-8 items-center rounded-sm border border-dashed border-border px-2.5 text-text-2"
        >
          {kind === 'user'
            ? 'Submitters pick people here.'
            : kind === 'link'
              ? 'Submitters pick records here.'
              : 'Submitters upload files here.'}
        </div>
      );
    default:
      return (
        <Input
          {...common}
          type={INPUT_TYPES[kind] ?? 'text'}
          inputMode={kind === 'number' || kind === 'duration' ? 'decimal' : undefined}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

const INPUT_TYPES: Partial<Record<string, string>> = { email: 'email', url: 'url', phone: 'tel' };
