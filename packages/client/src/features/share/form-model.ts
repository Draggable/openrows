import {
  type FieldMeta,
  isSafeRedirectUrl,
  type PublicForm,
  type PublicFormField,
  prefillAnswers,
  visibleFormFields,
} from '@openrows/shared';
import { ApiError } from '../../api/client';
import { editorKind } from '../grid/cells/model';
import { valuesOf } from '../views/form/FormPreview';

/**
 * Public forms: what the `/f/<token>` page computes. Answers are kept as the inputs hold
 * them (numbers as typed text) and read as values the conditions and the server understand.
 */

/** The public page of a form link. */
export function formUrl(token: string, origin: string = window.location.origin): string {
  return `${origin}/f/${token}`;
}

/** The registry's view of a public form field, for the inputs (they read type and options). */
export function formFieldMeta(field: PublicFormField): FieldMeta {
  return {
    ...field,
    tableId: '',
    description: null,
    position: 0,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  };
}

/**
 * The answers a form URL prefills (`prefill_<Field name>=`, for fields that allow it) as the
 * inputs hold them, and the prefilled fields to hide (`hide_<Field name>=true`).
 */
export function initialAnswers(
  form: PublicForm,
  search: string
): { answers: Record<string, unknown>; hidden: Set<string> } {
  const { values, hidden } = prefillAnswers(new URLSearchParams(search), form.entries, form.fields);
  const answers: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = values[field.id];
    if (value === undefined) continue;
    const kind = editorKind(formFieldMeta(field));
    if ((kind === 'number' || kind === 'duration') && typeof value === 'number') {
      answers[field.id] = String(value);
    } else if (kind === 'dateTime' && typeof value === 'string') {
      // The datetime-local input takes `YYYY-MM-DDTHH:mm`.
      answers[field.id] = value.slice(0, 16);
    } else {
      answers[field.id] = value;
    }
  }
  return { answers, hidden };
}

const blank = (v: unknown) =>
  v === null ||
  v === undefined ||
  v === false ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/** The fields shown for these answers, by id, in form order. */
export function shownFields(
  form: PublicForm,
  answers: Record<string, unknown>,
  fields: readonly FieldMeta[]
): Set<string> {
  const values = valuesOf(answers, fields);
  return new Set(visibleFormFields(form.entries, values, fields).map((e) => e.fieldId));
}

/** The submission's answers: shown fields only, blanks left out (the server refuses others). */
export function submissionFields(
  form: PublicForm,
  answers: Record<string, unknown>,
  fields: readonly FieldMeta[]
): Record<string, unknown> {
  const values = valuesOf(answers, fields);
  const shown = shownFields(form, answers, fields);
  return Object.fromEntries(Object.entries(values).filter(([id, v]) => shown.has(id) && !blank(v)));
}

/** Required shown fields still without an answer, by id. */
export function missingAnswers(
  form: PublicForm,
  answers: Record<string, unknown>,
  fields: readonly FieldMeta[]
): string[] {
  const values = valuesOf(answers, fields);
  const shown = shownFields(form, answers, fields);
  return form.entries
    .filter((e) => e.required && shown.has(e.fieldId) && blank(values[e.fieldId]))
    .map((e) => e.fieldId);
}

/** The server's per-field messages of a refused submission (`fields.<id>` paths), by field id. */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.status !== 422) return {};
  const errors = (err.data as { errors?: { path?: unknown; message?: unknown }[] } | undefined)
    ?.errors;
  const out: Record<string, string> = {};
  for (const e of errors ?? []) {
    const m = typeof e.path === 'string' ? /^fields\.([0-9a-f-]{36})$/i.exec(e.path) : null;
    if (m?.[1] && typeof e.message === 'string') out[m[1]] = e.message;
  }
  return out;
}

/** Where to send the submitter after submitting, only an `https:` URL (checked again here). */
export function redirectTarget(form: PublicForm): string | null {
  return form.afterSubmit === 'redirect' && form.redirectUrl && isSafeRedirectUrl(form.redirectUrl)
    ? form.redirectUrl
    : null;
}

/** A linked record answer as picked records, whatever the input held. */
export function linkAnswerOf(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) =>
    typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string'
      ? [{ id: (v as { id: string }).id, name: String((v as { name?: unknown }).name ?? '') }]
      : []
  );
}

/** Picks a record: added once, or in place of the one picked for a single-record link. */
export function pickLink(
  picked: readonly { id: string; name: string }[],
  record: { id: string; name: string },
  single: boolean
): { id: string; name: string }[] {
  if (single) return [record];
  return picked.some((r) => r.id === record.id) ? [...picked] : [...picked, record];
}
