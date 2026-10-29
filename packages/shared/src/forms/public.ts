import { z } from 'zod';
import { getFieldType, isFieldTypeName } from '../fields/index.js';
import { mimeTypeSchema } from '../schemas/attachment.js';
import { fieldTypeNameSchema } from '../schemas/field.js';
import { fieldPermissionsOf, formsMayFill } from '../schemas/permissions.js';
import { FORM_AFTER_SUBMIT, type FormField, formFieldSchema, isFormFieldType } from './config.js';

/**
 * Public forms: a form view published at `/f/<token>` (a share link of kind `form`),
 * answered by anyone with the link, no session. The server accepts only the fields on the form
 * (and only those shown for the answers), checks required answers and every value through the
 * field registry, and creates the record through the RecordService as the "Form" actor.
 */

/** The largest submission body, in bytes (the answers, not files: those upload separately). */
export const MAX_FORM_SUBMISSION_BYTES = 256 * 1024;
/** The largest file a form takes: the submitter is anonymous, so less than a cell's. */
export const MAX_FORM_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Most files one attachment answer holds. */
export const MAX_FORM_FILES_PER_FIELD = 10;
/** Most records one linked record answer picks (one for "link to a single record"). */
export const MAX_FORM_LINKS_PER_FIELD = 100;
/** Longest Turnstile response token accepted (Cloudflare documents 2,048 characters). */
export const MAX_CAPTCHA_TOKEN = 2048;

/**
 * Whether a form field of this type can be answered on a public form. People can't: picking
 * them would list the base's collaborators to anyone with the link (form links can't be limited
 * to signed-in members). Linked records can, through a view the form's creator picks.
 */
export function isPublicFormFieldType(type: string): boolean {
  return isFormFieldType(type) && type !== 'user';
}

/** Most records the public form's link picker answers per page. */
export const MAX_FORM_LINK_PAGE = 50;

/**
 * Why a field on a form stays off the public form, in words for the builder, or `null`
 * when the public form shows it. The server checks the same, plus that the picker's view is
 * still a shared view of the linked table and the link's inverse field may be filled.
 */
export function publicFormFieldProblem(
  field: { type: string; permissions?: unknown },
  entry: Pick<FormField, 'viewIdForRecordSelection'>
): string | null {
  if (field.type === 'user') {
    return "People fields can't be on a public form: anyone with the link would see your collaborators.";
  }
  if (!isPublicFormFieldType(field.type)) return "This field can't be on a public form.";
  if (field.type === 'link' && !entry.viewIdForRecordSelection) {
    return 'Choose the view whose records people can pick, or this field stays off the public form.';
  }
  if (!formsMayFill(fieldPermissionsOf(field.permissions))) {
    return 'Editors can’t edit this field, so it stays off the public form. Allow it to be filled through forms in its permissions.';
  }
  return null;
}

/**
 * `POST /api/forms/:formToken/submissions`: the answers by field id, the submitter's
 * idempotency key (a new UUID per filled-in form, so a double click or a retry creates one
 * record) and, when the form asks for one, the Turnstile token. Strict: nothing else (no record
 * id, no `createdBy`, no `records`) is accepted.
 */
export const formSubmissionSchema = z
  .object({
    submissionId: z.uuid(),
    fields: z.record(z.uuid(), z.unknown()),
    captchaToken: z.string().min(1).max(MAX_CAPTCHA_TOKEN).optional(),
  })
  .strict();

export type FormSubmissionInput = z.infer<typeof formSubmissionSchema>;

/** A submission's answer: nothing about the record it made. */
export const FormSubmittedSchema = z.object({ submitted: z.literal(true) });

/** A field as a public form shows it (the form's label, the display-safe options). */
export const PublicFormFieldSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: fieldTypeNameSchema,
  options: z.unknown(),
  isPrimary: z.boolean(),
});

/**
 * `GET /api/forms/:formToken`: what the public page draws. Only the form's fields that can be
 * answered publicly are listed; their conditions name only fields above them on the form.
 */
export const PublicFormSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  hasCover: z.boolean(),
  hasLogo: z.boolean(),
  submitLabel: z.string(),
  afterSubmit: z.enum(FORM_AFTER_SUBMIT),
  submitMessage: z.string().nullable(),
  redirectUrl: z.string().nullable(),
  showBranding: z.boolean(),
  entries: z.array(formFieldSchema),
  fields: z.array(PublicFormFieldSchema),
  /** The Turnstile site key when the form needs a CAPTCHA, else null. */
  captchaSiteKey: z.string().nullable(),
  /**
   * False while the base is at its plan's records per base: the page then says the form
   * isn't accepting responses, and submissions are refused.
   */
  accepting: z.boolean(),
});

export type PublicForm = z.infer<typeof PublicFormSchema>;
export type PublicFormField = z.infer<typeof PublicFormFieldSchema>;

/** `POST /api/forms/:formToken/attachments`: a file for an attachment field on the form. */
export const createFormUploadSchema = z
  .object({
    fieldId: z.uuid(),
    filename: z.string().trim().min(1).max(255),
    type: z.union([mimeTypeSchema, z.literal('')]).default(''),
    size: z.int().min(1).max(MAX_FORM_UPLOAD_BYTES),
  })
  .strict();

export type CreateFormUploadInput = z.input<typeof createFormUploadSchema>;

/**
 * `GET /api/forms/:formToken/fields/:fieldId/records`: a page of the records a link
 * field's picker offers (the form's chosen view), searched by their primary field.
 */
export const formLinkRecordsQuerySchema = z
  .object({
    search: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_FORM_LINK_PAGE).default(20),
    offset: z.coerce.number().int().min(0).max(10_000).default(0),
  })
  .strict();

export type FormLinkRecordsQuery = z.infer<typeof formLinkRecordsQuerySchema>;

/** The picker's page: record ids and their primary field as text, nothing else. */
export const FormLinkRecordsSchema = z.object({
  records: z.array(z.object({ id: z.uuid(), name: z.string() })),
  nextOffset: z.int().min(0).nullable(),
});

export type FormLinkRecords = z.infer<typeof FormLinkRecordsSchema>;

/** The URL parameter that prefills a field (`prefill_<Field name>`, like Airtable). */
export const PREFILL_PREFIX = 'prefill_';
/** The URL parameter that hides a prefilled field (`hide_<Field name>=true`). */
export const HIDE_PREFIX = 'hide_';

/**
 * The prefilled answers of a form URL's query: `prefill_<field name or id>=<text>` for fields
 * that allow prefill, coerced through the registry (unreadable values are dropped), and the
 * fields to hide (`hide_<name>=true`, only for fields actually prefilled). Multi-value fields
 * take comma-separated text, as the registry's coercion reads it.
 */
export function prefillAnswers(
  params: URLSearchParams,
  entries: readonly { fieldId: string; allowPrefill?: boolean | undefined }[],
  fields: readonly { id: string; name: string; type: string; options: unknown }[]
): { values: Record<string, unknown>; hidden: Set<string> } {
  const values: Record<string, unknown> = {};
  const hidden = new Set<string>();
  const byKey = new Map<string, (typeof fields)[number]>();
  for (const f of fields) {
    byKey.set(f.name, f);
    byKey.set(f.id, f);
  }
  const allowed = new Set(entries.filter((e) => e.allowPrefill).map((e) => e.fieldId));
  for (const [key, raw] of params) {
    if (!key.startsWith(PREFILL_PREFIX)) continue;
    const field = byKey.get(key.slice(PREFILL_PREFIX.length));
    if (!field || !allowed.has(field.id) || !isFieldTypeName(field.type)) continue;
    // Files upload, and linked records are picked from the form's view.
    if (field.type === 'attachment' || field.type === 'link') continue;
    const def = getFieldType(field.type);
    const options = def.optionsSchema.safeParse(field.options ?? {});
    if (!options.success) continue;
    const value = def.coerce(raw, options.data as never);
    if (value === null || value === undefined) continue;
    values[field.id] = value;
  }
  for (const [key, raw] of params) {
    if (!key.startsWith(HIDE_PREFIX) || raw !== 'true') continue;
    const field = byKey.get(key.slice(HIDE_PREFIX.length));
    if (field && field.id in values) hidden.add(field.id);
  }
  return { values, hidden };
}
