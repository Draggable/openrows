import {
  type FieldMeta,
  type FormField,
  type FormLayout,
  filterConditions,
  isFormFieldType,
  MAX_FORM_FIELDS,
  pruneFormLayout,
} from '@openrows/shared';

/** The live fields a form can hold, in table order (the primary field first). */
export function formableFields(fields: readonly FieldMeta[]): FieldMeta[] {
  const live = fields.filter((f) => !f.deletedAt && isFormFieldType(f.type));
  return [...live.filter((f) => f.isPrimary), ...live.filter((f) => !f.isPrimary)];
}

/** A form's entries with their fields (entries of fields that are gone are left out). */
export function formEntries(
  layout: FormLayout,
  fields: readonly FieldMeta[]
): { entry: FormField; field: FieldMeta }[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return (layout.fields ?? []).flatMap((entry) => {
    const field = byId.get(entry.fieldId);
    return field && !field.deletedAt && isFormFieldType(field.type) ? [{ entry, field }] : [];
  });
}

/** The fields that could still be added to the form, in table order. */
export function addableFields(layout: FormLayout, fields: readonly FieldMeta[]): FieldMeta[] {
  const on = new Set((layout.fields ?? []).map((f) => f.fieldId));
  return formableFields(fields).filter((f) => !on.has(f.id));
}

/** The form's fields with `fieldId` added at the end (unchanged if full or already there). */
export function addField(list: readonly FormField[], fieldId: string): FormField[] {
  if (list.length >= MAX_FORM_FIELDS || list.some((f) => f.fieldId === fieldId)) return [...list];
  return [...list, { fieldId }];
}

/**
 * The form's fields without the one at `index`. Conditions of fields below that used it lose
 * those conditions (a condition can only use fields above, on the form).
 */
export function removeField(
  list: readonly FormField[],
  index: number,
  fields: readonly FieldMeta[]
): FormField[] {
  const next = list.filter((_, i) => i !== index);
  return pruneFormLayout({ fields: next }, fields).fields ?? next;
}

/** The fields of conditions on the entry, by id. */
const conditionFieldIds = (entry: FormField) =>
  new Set(filterConditions(entry.condition).map((c) => c.fieldId));

/**
 * Why the field at `from` can't move to `to`: it would go above a field its condition uses,
 * or below one whose condition uses it. `null` when it can.
 */
export function moveProblem(
  list: readonly FormField[],
  from: number,
  to: number,
  nameOf: (fieldId: string) => string
): string | null {
  const moving = list[from];
  if (!moving || to < 0 || to >= list.length || to === from) return null;
  const passed = from < to ? list.slice(from + 1, to + 1) : list.slice(to, from);
  if (from > to) {
    const uses = conditionFieldIds(moving);
    const hit = passed.find((f) => uses.has(f.fieldId));
    if (hit) {
      return `${nameOf(moving.fieldId)} shows depending on ${nameOf(hit.fieldId)}, so it stays below it.`;
    }
  } else {
    const hit = passed.find((f) => conditionFieldIds(f).has(moving.fieldId));
    if (hit) {
      return `${nameOf(hit.fieldId)} shows depending on ${nameOf(moving.fieldId)}, so it stays above it.`;
    }
  }
  return null;
}

/** The list with the entry at `from` moved to `to`. */
export function moveField(list: readonly FormField[], from: number, to: number): FormField[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (!moved) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/** The fields a condition of the entry at `index` may use: the form's fields above it. */
export function conditionFields(
  list: readonly FormField[],
  index: number,
  fields: readonly FieldMeta[]
): FieldMeta[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return list.slice(0, index).flatMap((e) => {
    const f = byId.get(e.fieldId);
    return f ? [f] : [];
  });
}

/** The label a form shows for a field: its label override, else the field's name. */
export const labelOf = (entry: FormField, field: FieldMeta) => entry.label?.trim() || field.name;
