import {
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type FormField,
  type FormLayout,
  isFilterSubgroup,
  isSafeRedirectUrl,
  MAX_FORM_DESCRIPTION,
  MAX_FORM_HELP_TEXT,
  MAX_FORM_LABEL,
  MAX_FORM_MESSAGE,
  MAX_FORM_REDIRECT_URL,
  MAX_FORM_SUBMIT_LABEL,
  MAX_FORM_TITLE,
  publicFormFieldProblem,
} from '@openrows/shared';
import { EyeOff, ImagePlus, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useViews } from '../../../api/queries';
import { BRAND } from '../../../app/Logo';
import { Button, Input, Spinner, toast } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { fileUrl, uploadFormImage } from '../../attachments/upload';
import { ConditionRow, selectClass } from '../toolbar/FilterMenu';
import { canAddCondition, newCondition } from '../toolbar/model';
import { conditionFields } from './model';

const textareaClass =
  'w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-body hover:border-border-strong focus-visible:border-brand focus-visible:outline-none disabled:opacity-60';

const MARKDOWN_HINT = 'Markdown: **bold**, _italic_, [link](https://…), - lists';

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <label htmlFor={htmlFor} className="text-small text-text-2">
        {label}
      </label>
      {children}
    </div>
  );
}

function Check({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className={cn('flex h-7 items-center gap-2', !disabled && 'cursor-pointer')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--accent)]"
      />
      {children}
    </label>
  );
}

/**
 * One form field's settings, under it in the builder's list: a label in place of the
 * field's name, help text, required, prefill from the URL, and the conditions (on the fields
 * above it) under which it shows.
 */
export function FieldSettings({
  entry,
  field,
  index,
  list,
  fields,
  disabled,
  onChange,
}: {
  entry: FormField;
  field: FieldMeta;
  index: number;
  list: readonly FormField[];
  fields: readonly FieldMeta[];
  disabled: boolean;
  onChange: (entry: FormField) => void;
}) {
  const id = useId();
  const set = (patch: Partial<FormField>) => onChange({ ...entry, ...patch });
  const problem = publicFormFieldProblem(field, entry);
  return (
    <fieldset
      aria-label={`${field.name} settings`}
      disabled={disabled}
      className="grid gap-3 px-2 pt-2 pb-3"
    >
      {problem && (
        <p className="flex gap-2 text-small text-text-2" data-testid="form-field-problem">
          <EyeOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{problem}</span>
        </p>
      )}
      {field.type === 'link' && (
        <PickerView
          id={`${id}-picker`}
          field={field}
          value={entry.viewIdForRecordSelection ?? null}
          onChange={(viewIdForRecordSelection) => set({ viewIdForRecordSelection })}
        />
      )}
      <Row label="Label" htmlFor={`${id}-label`}>
        <Input
          id={`${id}-label`}
          value={entry.label ?? ''}
          placeholder={field.name}
          maxLength={MAX_FORM_LABEL}
          onChange={(e) => set({ label: e.target.value })}
        />
      </Row>
      <Row label="Help text" htmlFor={`${id}-help`}>
        <textarea
          id={`${id}-help`}
          rows={2}
          value={entry.helpText ?? ''}
          maxLength={MAX_FORM_HELP_TEXT}
          placeholder={field.description ?? 'Shown under the label'}
          onChange={(e) => set({ helpText: e.target.value })}
          className={textareaClass}
        />
        <span className="text-small text-text-2">{MARKDOWN_HINT}</span>
      </Row>
      <div className="grid">
        <Check
          checked={!!entry.required}
          disabled={disabled}
          onChange={(on) => set({ required: on })}
        >
          Required
        </Check>
        <Check
          checked={!!entry.allowPrefill}
          disabled={disabled}
          onChange={(on) => set({ allowPrefill: on })}
        >
          Allow prefill from the form's link
        </Check>
      </div>
      <ConditionEditor
        condition={entry.condition ?? null}
        fields={conditionFields(list, index, fields)}
        disabled={disabled}
        onChange={(condition) => set({ condition })}
      />
    </fieldset>
  );
}

/**
 * A link field's picker on the public form: the collaborative view of the linked table
 * whose records submitters may pick. They see those records' primary field, nothing else.
 */
function PickerView({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: FieldMeta;
  value: string | null;
  onChange: (viewId: string | null) => void;
}) {
  const linked = (field.options as { linkedTableId?: string | null } | null)?.linkedTableId ?? '';
  const views = (useViews(linked).data?.views ?? []).filter(
    (v) => !v.personal && v.type !== 'form'
  );
  return (
    <Row label="Records people can pick" htmlFor={id}>
      <select
        id={id}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className={cn(selectClass, 'h-8 w-full')}
      >
        <option value="">Choose a view…</option>
        {views.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <span className="text-small text-text-2">
        Anyone with the form’s link can search this view’s records by their primary field.
      </span>
    </Row>
  );
}

function ConditionEditor({
  condition,
  fields,
  disabled,
  onChange,
}: {
  condition: FilterGroup | null;
  fields: FieldMeta[];
  disabled: boolean;
  onChange: (condition: FilterGroup | null) => void;
}) {
  const on = !!condition && condition.conditions.length > 0;
  const first = fields[0];
  if (!first && !on) {
    return (
      <p className="text-small text-text-2">
        Fields below others can show depending on their answers.
      </p>
    );
  }
  const setEntry = (i: number, next: FilterCondition | null) => {
    if (!condition) return;
    const conditions = [...condition.conditions];
    if (next) conditions[i] = next;
    else conditions.splice(i, 1);
    onChange(conditions.length > 0 ? { ...condition, conditions } : null);
  };
  return (
    <div className="grid gap-2">
      <Check
        checked={on}
        disabled={disabled || !first}
        onChange={(checked) =>
          onChange(
            checked && first ? { conjunction: 'and', conditions: [newCondition(first)] } : null
          )
        }
      >
        Show only when conditions match
      </Check>
      {on && condition && (
        <div className="grid gap-1.5 rounded-sm border border-border bg-surface p-2">
          {condition.conditions.length > 1 && (
            <label className="flex items-center gap-1.5 text-small text-text-2">
              Show when
              <select
                aria-label="Conjunction"
                value={condition.conjunction}
                onChange={(e) =>
                  onChange({ ...condition, conjunction: e.target.value as 'and' | 'or' })
                }
                className={selectClass}
              >
                <option value="and">all match</option>
                <option value="or">any matches</option>
              </select>
            </label>
          )}
          {condition.conditions.map((c, i) =>
            isFilterSubgroup(c) ? (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id
                key={i}
                className="flex items-center justify-between text-small text-text-2"
              >
                A group of {c.conditions.length} conditions
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove condition group"
                  onClick={() => setEntry(i, null)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ) : (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id
                key={i}
                className={cn(
                  // The panel is narrow: field and operator share a line, the value gets its own.
                  'grid [&_[data-testid=filter-condition]]:flex-wrap',
                  '[&_[data-testid=filter-condition]>select]:w-auto [&_[data-testid=filter-condition]>select]:min-w-0 [&_[data-testid=filter-condition]>select]:flex-1',
                  '[&_[data-testid=filter-condition]>div]:order-last [&_[data-testid=filter-condition]>div]:basis-full'
                )}
              >
                <ConditionRow fields={fields} cond={c} onChange={(next) => setEntry(i, next)} />
              </div>
            )
          )}
          {first && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || !canAddCondition(condition)}
                onClick={() =>
                  onChange({
                    ...condition,
                    conditions: [...condition.conditions, newCondition(first)],
                  })
                }
              >
                <Plus aria-hidden /> Add condition
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The form's own settings: title, description, cover and logo images, the submit
 * button's label, what happens after a submission (a message, or a redirect to an https URL)
 * and the OpenRows branding (stored only; removing it is a paid plan feature from M5).
 */
export function FormSettings({
  layout,
  tableId,
  viewId,
  fallbackTitle,
  disabled,
  onChange,
}: {
  layout: FormLayout;
  tableId: string;
  viewId: string | undefined;
  fallbackTitle: string;
  disabled: boolean;
  onChange: (patch: FormLayout) => void;
}) {
  const id = useId();
  const afterSubmit = layout.afterSubmit ?? 'message';
  const [mode, setMode] = useState(afterSubmit);
  const [url, setUrl] = useState(layout.redirectUrl ?? '');
  const urlProblem = url.trim() !== '' && !isSafeRedirectUrl(url.trim());
  const setRedirect = (next: string) => {
    setUrl(next);
    const u = next.trim();
    if (u === '') {
      // Redirecting needs a URL: stay on the message until there is one.
      if (afterSubmit === 'redirect') onChange({ afterSubmit: 'message', redirectUrl: null });
      else onChange({ redirectUrl: null });
    } else if (isSafeRedirectUrl(u)) {
      onChange({ afterSubmit: 'redirect', redirectUrl: u });
    }
  };
  return (
    <fieldset aria-label="Form settings" disabled={disabled} className="grid gap-4 p-1">
      <Row label="Title" htmlFor={`${id}-title`}>
        <Input
          id={`${id}-title`}
          value={layout.title ?? ''}
          placeholder={fallbackTitle}
          maxLength={MAX_FORM_TITLE}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </Row>
      <Row label="Description" htmlFor={`${id}-description`}>
        <textarea
          id={`${id}-description`}
          rows={3}
          value={layout.description ?? ''}
          maxLength={MAX_FORM_DESCRIPTION}
          onChange={(e) => onChange({ description: e.target.value })}
          className={textareaClass}
        />
        <span className="text-small text-text-2">{MARKDOWN_HINT}</span>
      </Row>
      <ImageSetting
        label="Cover image"
        tableId={tableId}
        viewId={viewId}
        value={layout.coverAttachmentId ?? null}
        disabled={disabled}
        onChange={(coverAttachmentId) => onChange({ coverAttachmentId })}
      />
      <ImageSetting
        label="Logo"
        tableId={tableId}
        viewId={viewId}
        value={layout.logoAttachmentId ?? null}
        disabled={disabled}
        onChange={(logoAttachmentId) => onChange({ logoAttachmentId })}
      />
      <Row label="Submit button" htmlFor={`${id}-submit`}>
        <Input
          id={`${id}-submit`}
          value={layout.submitLabel ?? ''}
          placeholder="Submit"
          maxLength={MAX_FORM_SUBMIT_LABEL}
          onChange={(e) => onChange({ submitLabel: e.target.value })}
        />
      </Row>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1 text-small text-text-2">After a submission</legend>
        {(['message', 'redirect'] as const).map((m) => (
          <label key={m} className="flex h-7 cursor-pointer items-center gap-2">
            <input
              type="radio"
              name={`${id}-after`}
              checked={mode === m}
              onChange={() => {
                setMode(m);
                if (m === 'message') onChange({ afterSubmit: 'message' });
                else if (isSafeRedirectUrl(url.trim())) {
                  onChange({ afterSubmit: 'redirect', redirectUrl: url.trim() });
                }
              }}
              className="size-4 accent-[var(--accent)]"
            />
            {m === 'message' ? 'Show a message' : 'Redirect to a URL'}
          </label>
        ))}
        {mode === 'message' ? (
          <>
            <textarea
              aria-label="Message after a submission"
              rows={2}
              value={layout.submitMessage ?? ''}
              placeholder="Thank you for submitting the form!"
              maxLength={MAX_FORM_MESSAGE}
              onChange={(e) => onChange({ submitMessage: e.target.value })}
              className={textareaClass}
            />
            <span className="text-small text-text-2">{MARKDOWN_HINT}</span>
          </>
        ) : (
          <>
            <Input
              aria-label="Redirect URL"
              type="url"
              inputMode="url"
              value={url}
              placeholder="https://example.com/thanks"
              maxLength={MAX_FORM_REDIRECT_URL}
              aria-invalid={urlProblem || undefined}
              aria-describedby={`${id}-url-note`}
              onChange={(e) => setRedirect(e.target.value)}
              className={cn(urlProblem && 'border-danger')}
            />
            <span
              id={`${id}-url-note`}
              className={cn('text-small', urlProblem ? 'text-danger' : 'text-text-2')}
            >
              {urlProblem
                ? 'Use a full https:// address.'
                : 'Only https:// addresses. Until one is set, the message shows.'}
            </span>
          </>
        )}
      </fieldset>
      <div className="grid gap-0.5">
        <Check
          checked={layout.showBranding !== false}
          disabled={disabled}
          onChange={(on) => onChange({ showBranding: on })}
        >
          Show “Made with {BRAND}”
        </Check>
        <span className="pl-6 text-small text-text-2">
          Removing the branding will need a paid plan.
        </span>
      </div>
    </fieldset>
  );
}

function ImageSetting({
  label,
  tableId,
  viewId,
  value,
  disabled,
  onChange,
}: {
  label: string;
  tableId: string;
  viewId: string | undefined;
  value: string | null;
  disabled: boolean;
  onChange: (id: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File | undefined) => {
    if (!file || !viewId) return;
    setBusy(true);
    try {
      const uploaded = await uploadFormImage(tableId, viewId, file);
      onChange(uploaded.id);
    } catch (err) {
      toast.error(
        err instanceof ApiError || err instanceof Error ? err.message : "Couldn't upload the image"
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="grid gap-1">
      <span className="text-small text-text-2">{label}</span>
      <div className="flex items-center gap-2">
        {value && (
          <img
            src={fileUrl(tableId, value)}
            alt=""
            className="h-10 w-16 rounded-xs border border-border object-cover"
          />
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-label={`Upload ${label.toLowerCase()}`}
          onChange={(e) => upload(e.target.files?.[0])}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || busy || !viewId}
          onClick={() => input.current?.click()}
        >
          {busy ? <Spinner /> : <ImagePlus aria-hidden />}
          {value ? 'Replace' : 'Upload'}
        </Button>
        {value && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Remove ${label.toLowerCase()}`}
            onClick={() => onChange(null)}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
