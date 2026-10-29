import { z } from 'zod';
import { getFieldType, isFieldTypeName } from '../fields/index.js';
import {
  type FilterCondition,
  type FilterGroup,
  filterGroupSchema,
  isFilterSubgroup,
  pruneViewQuery,
} from '../query/index.js';

/** Most fields a form shows. */
export const MAX_FORM_FIELDS = 500;
export const MAX_FORM_TITLE = 255;
export const MAX_FORM_DESCRIPTION = 10_000;
export const MAX_FORM_LABEL = 255;
export const MAX_FORM_HELP_TEXT = 2_000;
export const MAX_FORM_SUBMIT_LABEL = 60;
export const MAX_FORM_MESSAGE = 2_000;
export const MAX_FORM_REDIRECT_URL = 2_048;

/**
 * Whether a field type can be on a form: anything a person types or picks. Computed fields
 * (formula, lookup, rollup, count), auto numbers, created/modified times and people, and
 * buttons can't.
 */
export function isFormFieldType(type: string): boolean {
  if (!isFieldTypeName(type)) return false;
  const def = getFieldType(type);
  return !def.readOnly && !def.computed;
}

/**
 * Where a form sends the submitter: an `https:` URL, spelled out (no credentials), at most
 * 2,048 characters. Anything else (`http:`, `javascript:`, `data:`, relative) is refused.
 */
export function isSafeRedirectUrl(url: string): boolean {
  if (url.length > MAX_FORM_REDIRECT_URL || /\s/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname !== '' &&
    parsed.username === '' &&
    parsed.password === ''
  );
}

/**
 * One field of a form, in form order: a label in place of the field's name, help text
 * (Markdown, the rich text subset of `sanitizeMarkdown`), whether an answer is required,
 * whether the form's URL may prefill it (`?prefill_<field name>=`), and the condition
 * (a ViewQuery filter on fields above it) under which it shows.
 */
export const formFieldSchema = z
  .object({
    fieldId: z.uuid(),
    label: z.string().trim().max(MAX_FORM_LABEL).optional(),
    helpText: z.string().max(MAX_FORM_HELP_TEXT).optional(),
    required: z.boolean().optional(),
    allowPrefill: z.boolean().optional(),
    /** Show the field only when the answers above it match; `null` or absent: always. */
    condition: filterGroupSchema.nullable().optional(),
    /**
     * A link field's picker on the public form: the view of the linked table whose
     * records submitters may pick (and see the primary field of). Without one, a link field
     * stays off the public form.
     */
    viewIdForRecordSelection: z.uuid().nullable().optional(),
  })
  .strict();

export const FORM_AFTER_SUBMIT = ['message', 'redirect'] as const;
export type FormAfterSubmit = (typeof FORM_AFTER_SUBMIT)[number];

/**
 * The form layout of a view, kept under `config.form`. A patch replaces the keys it
 * names (`fields` as a whole). The cover and logo are images uploaded for the view
 * (`POST /api/tables/:tableId/attachments` with `viewId`). `showBranding` is stored only:
 * turning it off is plan-gated in M5.
 */
export const formLayoutSchema = z
  .object({
    fields: z.array(formFieldSchema).max(MAX_FORM_FIELDS).optional(),
    title: z.string().trim().max(MAX_FORM_TITLE).optional(),
    description: z.string().max(MAX_FORM_DESCRIPTION).optional(),
    coverAttachmentId: z.uuid().nullable().optional(),
    logoAttachmentId: z.uuid().nullable().optional(),
    submitLabel: z.string().trim().max(MAX_FORM_SUBMIT_LABEL).optional(),
    afterSubmit: z.enum(FORM_AFTER_SUBMIT).optional(),
    /** Shown after a submission (`afterSubmit: 'message'`); Markdown like the help text. */
    submitMessage: z.string().max(MAX_FORM_MESSAGE).optional(),
    /** Where the submitter goes (`afterSubmit: 'redirect'`): `https:` only. */
    redirectUrl: z
      .string()
      .trim()
      .max(MAX_FORM_REDIRECT_URL)
      .refine((u) => u === '' || isSafeRedirectUrl(u), 'Use a full https:// URL.')
      .nullable()
      .optional(),
    showBranding: z.boolean().optional(),
  })
  .strict();

export type FormField = z.infer<typeof formFieldSchema>;
export type FormLayout = z.infer<typeof formLayoutSchema>;

/** The form layout saved in a view's config, or `{}` when absent or unreadable. */
export function formLayoutOf(config: Record<string, unknown> | undefined): FormLayout {
  const parsed = formLayoutSchema.safeParse(config?.['form'] ?? {});
  return parsed.success ? parsed.data : {};
}

/** The conditions of a filter, nested groups flattened. */
export function filterConditions(filter: FilterGroup | null | undefined): FilterCondition[] {
  return (filter?.conditions ?? []).flatMap((entry) =>
    isFilterSubgroup(entry) ? entry.conditions : [entry]
  );
}

/** A problem with a form layout, with its path under `form`. */
export interface FormLayoutProblem {
  path: string;
  message: string;
}

/**
 * The structural problems of a form layout against the table's fields: unknown fields, fields
 * of a type a form can't hold, the same field twice, conditions naming a field that isn't
 * above the conditioned one on the form, and a redirect without a URL. Operators and values of
 * conditions are checked by the server's query compiler.
 */
export function formLayoutProblems(
  layout: FormLayout,
  fields: readonly { id: string; type: string }[]
): FormLayoutProblem[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const problems: FormLayoutProblem[] = [];
  const above = new Set<string>();
  (layout.fields ?? []).forEach((entry, i) => {
    const path = `fields.${i}`;
    const field = byId.get(entry.fieldId);
    if (!field) {
      problems.push({ path: `${path}.fieldId`, message: 'No such field in this table.' });
    } else if (!isFormFieldType(field.type)) {
      problems.push({
        path: `${path}.fieldId`,
        message: "Computed, automatic and button fields can't be on a form.",
      });
    } else if (above.has(entry.fieldId)) {
      problems.push({ path: `${path}.fieldId`, message: 'This field is already on the form.' });
    } else if (entry.viewIdForRecordSelection && field.type !== 'link') {
      problems.push({
        path: `${path}.viewIdForRecordSelection`,
        message: 'Only a linked record field picks records from a view.',
      });
    }
    let n = 0;
    for (const [j, cond] of (entry.condition?.conditions ?? []).entries()) {
      const conds = isFilterSubgroup(cond)
        ? cond.conditions.map((c, k) => ({ c, p: `condition.conditions.${j}.conditions.${k}` }))
        : [{ c: cond, p: `condition.conditions.${j}` }];
      for (const { c, p } of conds) {
        n++;
        if (!above.has(c.fieldId)) {
          problems.push({
            path: `${path}.${p}.fieldId`,
            message: byId.has(c.fieldId)
              ? 'A condition can only use fields above this one on the form.'
              : 'No such field in this table.',
          });
        }
      }
    }
    if (n > 50) {
      problems.push({ path: `${path}.condition`, message: 'At most 50 conditions.' });
    }
    above.add(entry.fieldId);
  });
  if (layout.afterSubmit === 'redirect' && !layout.redirectUrl) {
    problems.push({ path: 'redirectUrl', message: 'Add the https:// URL to redirect to.' });
  }
  return problems;
}

/**
 * Drops the form entries of fields that aren't live or can't be on a form any more (converted
 * since), and the conditions on fields that are no longer above their field (`pruneViewQuery`
 * over the fields above); a condition left empty goes. Works on the client and the server.
 */
export function pruneFormLayout(
  layout: FormLayout,
  fields: readonly { id: string; type: string }[]
): FormLayout {
  if (!layout.fields) return layout;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const above: { id: string; type: string }[] = [];
  const seen = new Set<string>();
  const out: FormField[] = [];
  for (const entry of layout.fields) {
    const field = byId.get(entry.fieldId);
    if (!field || !isFormFieldType(field.type) || seen.has(field.id)) continue;
    seen.add(field.id);
    const next: FormField = { ...entry };
    if (entry.condition) {
      const filter = pruneViewQuery({ filter: entry.condition }, above).filter;
      next.condition = filter && filter.conditions.length > 0 ? filter : null;
    }
    out.push(next);
    above.push(field);
  }
  return { ...layout, fields: out };
}
