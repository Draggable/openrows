import {
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  type ConditionField,
  type CreateFormUploadInput,
  createFormUploadSchema,
  FORM_SUBJECT,
  type FormField,
  type FormLayout,
  type FormLinkRecordsQuery,
  type FormSubmissionInput,
  formLayoutOf,
  MAX_FORM_FILES_PER_FIELD,
  MAX_FORM_LINKS_PER_FIELD,
  type ProblemFieldError,
  type PublicForm,
  permissionAllows,
  pruneFormLayout,
  publicFieldOptions,
  publicFormFieldProblem,
  tablePermissionsOf,
  visibleFormFields,
} from '@openrows/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import {
  confirmUpload,
  signedDownload,
  storageKey,
  toValue,
  type UploadScanning,
  USABLE_STATUSES,
} from '../attachments/service.js';
import type { ObjectStore } from '../attachments/storage.js';
import { emit } from '../data/outbox.js';
import { attachments, formSubmissions, tables, views } from '../db/index.js';
import type { Entitlements } from '../edition/types.js';
import { fieldType, type TableRow } from '../fields/service.js';
import { AppError } from '../lib/errors.js';
import { cellDenial } from '../records/permissions.js';
import {
  createRecords,
  type FieldInfo,
  formLinkRecords,
  type RecordReadContext,
  tableFields,
} from '../records/service.js';
import type { ShareContext } from '../shares/service.js';
import { loadTable } from '../tables/service.js';
import { assertAttachmentRoom, baseRecords, withPublicQuota } from '../usage/quota.js';

/**
 * Public forms. Legacy forms let a submitter set any column of the record (review
 * finding H4, mass assignment). Here the stored form layout is the allowlist: a submission may
 * only answer fields on the form, that a public form can take (no computed, automatic or people
 * fields, no link field without the view its picker offers, none the edit permissions
 * keep from editors unless the field allows forms), and only while their condition holds
 * for the other answers. Everything else is a 422 naming the field. Values go through the field
 * registry and the RecordService (outbox, computed fields, revisions), as the "Form" actor (no
 * user).
 */

/** A live form link's form: its view, table, the fields it may answer and its entries. */
export interface LoadedForm {
  ctx: ShareContext;
  view: { id: string; name: string };
  table: TableRow;
  layout: FormLayout;
  /** The form's entries a public form shows, in order, pruned to `fields`. */
  entries: FormField[];
  /** The fields the form may answer, by id. */
  fields: Map<string, FieldInfo>;
  /** Link fields' picker views: the view of the linked table each one offers, by field id. */
  linkViews: Map<string, string>;
}

const NO_SUCH_FORM = () => new AppError('NOT_FOUND', { detail: 'No such form.' });

/** The form of a live form link; 404 when its view isn't a live form view of the link's base. */
export async function loadForm(ctx: ShareContext): Promise<LoadedForm> {
  const [view] = await ctx.tx
    .select({
      id: views.id,
      name: views.name,
      type: views.type,
      config: views.config,
      tableId: views.tableId,
      baseId: tables.baseId,
    })
    .from(views)
    .innerJoin(tables, and(eq(tables.id, views.tableId), isNull(tables.deletedAt)))
    .where(and(eq(views.id, ctx.share.viewId ?? ''), isNull(views.deletedAt)));
  if (view?.type !== 'form' || view.baseId !== ctx.share.baseId) throw NO_SUCH_FORM();
  const table = await loadTable(ctx.tx, view.tableId);
  const layout = formLayoutOf(view.config as Record<string, unknown>);
  const entryOf = new Map((layout.fields ?? []).map((e) => [e.fieldId, e]));
  const onForm = (await tableFields(ctx.tx, table)).flatMap((f) => {
    const entry = entryOf.get(f.row.id);
    return entry ? [{ f, entry }] : [];
  });
  // A link's picker view must still be a shared view of the linked table.
  const wantedViews = onForm.flatMap(({ entry }) =>
    entry.viewIdForRecordSelection ? [entry.viewIdForRecordSelection] : []
  );
  const liveViews = new Map(
    (wantedViews.length
      ? await ctx.tx
          .select({ id: views.id, tableId: views.tableId })
          .from(views)
          .where(
            and(
              inArray(views.id, wantedViews),
              isNull(views.deletedAt),
              eq(views.personal, false),
              sql`${views.type} <> 'form'`
            )
          )
      : []
    ).map((v) => [v.id, v.tableId])
  );
  const linkViews = new Map<string, string>();
  const answerable = onForm.flatMap(({ f, entry }) => {
    const type = fieldType(f.row);
    if (publicFormFieldProblem({ type, permissions: f.row.permissions }, entry)) return [];
    if (cellDenial(table, f, FORM_SUBJECT, 'form') !== null) return [];
    if (type === 'link') {
      const viewId = entry.viewIdForRecordSelection;
      if (!viewId || !f.link || liveViews.get(viewId) !== f.link.target.id) return [];
      linkViews.set(f.row.id, viewId);
    }
    return [f];
  });
  // Fields the form can't answer go as if deleted, with the conditions that named them.
  const pruned = pruneFormLayout(
    layout,
    answerable.map((f) => ({ id: f.row.id, type: f.row.type }))
  );
  return {
    ctx,
    view: { id: view.id, name: view.name },
    table,
    layout,
    entries: pruned.fields ?? [],
    fields: new Map(answerable.map((f) => [f.row.id, f])),
    linkViews,
  };
}

/** The Form actor's read of the form's table (`me` in a view's filter matches nobody). */
const formReader = (form: LoadedForm): RecordReadContext => ({
  tx: form.ctx.tx,
  workspaceId: form.ctx.workspaceId,
  userId: FORM_SUBJECT.userId,
  table: form.table,
});

/**
 * `GET /api/forms/:token/fields/:fieldId/records`: a page of the records a link field
 * on the form offers, from the view the form's creator chose, as ids and primary text only.
 * A field that isn't a pickable link on this form is a 404, so nothing else can be listed.
 */
export async function formLinkPage(form: LoadedForm, fieldId: string, query: FormLinkRecordsQuery) {
  const field = form.fields.get(fieldId);
  const viewId = form.linkViews.get(fieldId);
  const page =
    field && viewId && form.entries.some((e) => e.fieldId === fieldId)
      ? await formLinkRecords(formReader(form), field, viewId, query)
      : null;
  if (!page)
    throw new AppError('NOT_FOUND', { detail: 'No such linked record field on this form.' });
  return page;
}

/** What a visitor reads when the base is at its plan's records per base. */
export const FORM_NOT_ACCEPTING = "This form isn't accepting responses right now.";

/**
 * Whether the form's base has room for one more record under the plan; the page says the
 * form isn't accepting responses otherwise. Unlimited plans cost no query.
 */
export async function formAccepting(
  form: LoadedForm,
  entitlements: Entitlements
): Promise<boolean> {
  const max = entitlements.limit('recordsPerBase');
  if (max === null) return true;
  return (await baseRecords(form.ctx.tx, form.table.baseId)) < max;
}

/** What `GET /api/forms/:token` answers: the form as the public page draws it. */
export function publicForm(
  form: LoadedForm,
  captchaSiteKey: string | null,
  accepting: boolean
): PublicForm {
  const { layout } = form;
  const redirect = layout.afterSubmit === 'redirect' && layout.redirectUrl;
  return {
    title: layout.title?.trim() || form.view.name,
    description: layout.description?.trim() || null,
    hasCover: Boolean(layout.coverAttachmentId),
    hasLogo: Boolean(layout.logoAttachmentId),
    submitLabel: layout.submitLabel?.trim() || 'Submit',
    afterSubmit: redirect ? 'redirect' : 'message',
    submitMessage: layout.submitMessage?.trim() || null,
    redirectUrl: redirect ? layout.redirectUrl || null : null,
    showBranding: layout.showBranding !== false,
    // The picker's view stays private: the field id is all the picker route needs.
    entries: form.entries.map(({ viewIdForRecordSelection: _, ...entry }) => entry),
    fields: form.entries.flatMap((e) => {
      const f = form.fields.get(e.fieldId);
      if (!f) return [];
      const type = fieldType(f.row);
      return [
        {
          id: f.row.id,
          name: f.row.name,
          type,
          options: publicFieldOptions(type, f.row.config),
          isPrimary: f.row.isPrimary,
        },
      ];
    }),
    captchaSiteKey,
    accepting,
  };
}

/** A signed URL of the form's cover or logo (nothing else of the base). */
export async function formImageUrl(
  form: LoadedForm,
  store: ObjectStore | undefined,
  image: string
): Promise<string> {
  const id =
    image === 'cover'
      ? form.layout.coverAttachmentId
      : image === 'logo'
        ? form.layout.logoAttachmentId
        : null;
  if (!id) throw new AppError('NOT_FOUND', { detail: 'This form has no such image.' });
  const [row] = await form.ctx.tx
    .select({ viewId: attachments.viewId })
    .from(attachments)
    .where(eq(attachments.id, id));
  if (row?.viewId !== form.view.id) {
    throw new AppError('NOT_FOUND', { detail: 'This form has no such image.' });
  }
  return signedDownload(
    { tx: form.ctx.tx, workspaceId: form.ctx.workspaceId, table: form.table },
    store,
    id,
    false
  );
}

function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === false ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function refuse(errors: ProblemFieldError[]): never {
  throw new AppError('VALIDATION_FAILED', {
    detail: 'Some answers are invalid.',
    extensions: { errors },
  });
}

/**
 * Accepts one submission of the form (in the link's read-write transaction): the allowlist,
 * conditions, required answers and the form's uploads, then one record through the
 * RecordService. Once per `submissionId`: a repeat answers the same without a second record.
 * Answers nothing about the record.
 */
export async function submitForm(
  form: LoadedForm,
  input: FormSubmissionInput,
  entitlements: Entitlements
): Promise<{ submitted: true; created: boolean }> {
  const { ctx } = form;
  // Serialize repeats of one submission, so a double click can't make two records.
  await ctx.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`form:${ctx.share.id}:${input.submissionId}`}, 0))`
  );
  const [seen] = await ctx.tx
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.shareId, ctx.share.id),
        eq(formSubmissions.submissionId, input.submissionId)
      )
    );
  if (seen) return { submitted: true, created: false };

  const errors: ProblemFieldError[] = [];
  const onForm = new Set(form.entries.map((e) => e.fieldId));
  const values: Record<string, unknown> = {};
  for (const [fieldId, raw] of Object.entries(input.fields)) {
    const path = `fields.${fieldId}`;
    const field = form.fields.get(fieldId);
    if (!field || !onForm.has(fieldId)) {
      errors.push({ path, message: "This field isn't on the form." });
      continue;
    }
    if (field.link && Array.isArray(raw) && raw.length > linkCap(field)) {
      errors.push({ path, message: `Pick at most ${linkCap(field)} record(s).` });
      continue;
    }
    const value = field.def.coerce(raw, field.options as never);
    if (value === null && !isBlank(raw)) {
      errors.push({ path, message: `Not a valid ${field.def.label.toLowerCase()} value.` });
      continue;
    }
    values[fieldId] = value;
  }
  if (errors.length) refuse(errors);
  await pickedRecords(form, values, errors);
  if (errors.length) refuse(errors);

  const conditionFields: ConditionField[] = [...form.fields.values()].map((f) => ({
    id: f.row.id,
    type: f.row.type,
    options: f.options,
  }));
  const shown = visibleFormFields(form.entries, values, conditionFields);
  const shownIds = new Set(shown.map((e) => e.fieldId));
  const cells: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(values)) {
    if (shownIds.has(fieldId)) {
      if (!isBlank(value)) cells[fieldId] = value;
    } else if (!isBlank(value)) {
      errors.push({
        path: `fields.${fieldId}`,
        message: "This field isn't shown for these answers.",
      });
    }
  }
  for (const entry of shown) {
    if (entry.required && isBlank(values[entry.fieldId])) {
      errors.push({ path: `fields.${entry.fieldId}`, message: 'An answer is required.' });
    }
  }
  const uploads = await lockUploads(form, cells, errors);
  if (errors.length) refuse(errors);

  assertFormMayAdd(form.table);
  // Past the plan's records per base the visitor learns only that the form is full.
  const [record] = await withPublicQuota(FORM_NOT_ACCEPTING, () =>
    createRecords(
      {
        tx: ctx.tx,
        workspaceId: ctx.workspaceId,
        userId: FORM_SUBJECT.userId,
        role: FORM_SUBJECT.role,
        table: form.table,
        unmatchedLinks: 'error',
        form: { shareId: ctx.share.id },
        entitlements,
      },
      [cells]
    )
  );
  if (!record) throw new Error('form submission: no record created');
  if (uploads.length) {
    const claimed = await ctx.tx
      .update(attachments)
      .set({ recordId: record.id })
      .where(and(inArray(attachments.id, uploads), isNull(attachments.recordId)))
      .returning({ id: attachments.id });
    if (claimed.length !== uploads.length) throw new Error('form uploads claimed concurrently');
  }
  await ctx.tx.insert(formSubmissions).values({
    workspaceId: ctx.workspaceId,
    baseId: form.table.baseId,
    shareId: ctx.share.id,
    tableId: form.table.id,
    recordId: record.id,
    submissionId: input.submissionId,
  });
  // For form-submitted automations: which form, which record.
  await emit(ctx.tx, {
    workspaceId: ctx.workspaceId,
    baseId: form.table.baseId,
    tableId: form.table.id,
    kind: 'form.submitted',
    payload: { recordId: record.id, viewId: form.view.id },
    actorId: null,
  });
  return { submitted: true, created: true };
}

/** Most records a link answer may pick. */
const linkCap = (field: FieldInfo) =>
  (field.options as { prefersSingleRecordLink?: boolean }).prefersSingleRecordLink
    ? 1
    : MAX_FORM_LINKS_PER_FIELD;

/**
 * Link answers may only pick records the field's picker offers (the form's chosen view of
 * the linked table): anything else (a record outside the view, of another table or base, a
 * made-up id) is a 422. The answers then carry the records' names, for the conditions.
 */
async function pickedRecords(
  form: LoadedForm,
  values: Record<string, unknown>,
  errors: ProblemFieldError[]
) {
  for (const [fieldId, value] of Object.entries(values)) {
    const field = form.fields.get(fieldId);
    const viewId = form.linkViews.get(fieldId);
    if (!field?.link || !Array.isArray(value) || value.length === 0) continue;
    const ids = (value as { id: string }[]).map((x) => x.id);
    const found = viewId ? await formLinkRecords(formReader(form), field, viewId, { ids }) : null;
    const byId = new Map((found?.records ?? []).map((r) => [r.id, r]));
    if (ids.some((id) => !byId.has(id))) {
      errors.push({ path: `fields.${fieldId}`, message: 'Pick records from the list.' });
      continue;
    }
    values[fieldId] = ids.map((id) => byId.get(id));
  }
}

/** A table whose "add records" permission excludes editors takes no form submissions. */
function assertFormMayAdd(table: TableRow) {
  if (!permissionAllows(tablePermissionsOf(table.permissions).addRecords, FORM_SUBJECT)) {
    throw new AppError('EDIT_RESTRICTED', {
      detail: "This form isn't accepting submissions.",
    });
  }
}

/**
 * The form's uploads named in attachment answers, locked: each must be a ready file uploaded
 * through this link for that field and not submitted yet, at most MAX_FORM_FILES_PER_FIELD per
 * answer. Anything else (another record's file, another form's, a made-up id) is a 422.
 */
async function lockUploads(
  form: LoadedForm,
  cells: Record<string, unknown>,
  errors: ProblemFieldError[]
): Promise<string[]> {
  const wanted: { fieldId: string; id: string }[] = [];
  for (const [fieldId, value] of Object.entries(cells)) {
    if (form.fields.get(fieldId)?.def.name !== 'attachment' || !Array.isArray(value)) continue;
    if (value.length > MAX_FORM_FILES_PER_FIELD) {
      errors.push({
        path: `fields.${fieldId}`,
        message: `At most ${MAX_FORM_FILES_PER_FIELD} files.`,
      });
      continue;
    }
    for (const item of value as { id: string }[]) wanted.push({ fieldId, id: item.id });
  }
  if (wanted.length === 0) return [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = [...new Set(wanted.map((w) => w.id).filter((id) => uuid.test(id)))];
  const rows = ids.length
    ? await form.ctx.tx
        .select({ id: attachments.id, fieldId: attachments.fieldId })
        .from(attachments)
        .where(
          and(
            inArray(attachments.id, ids),
            eq(attachments.shareId, form.ctx.share.id),
            inArray(attachments.status, [...USABLE_STATUSES]),
            isNull(attachments.recordId)
          )
        )
        .for('update')
    : [];
  const fieldOf = new Map(rows.map((r) => [r.id, r.fieldId]));
  for (const w of wanted) {
    if (fieldOf.get(w.id) !== w.fieldId) {
      errors.push({
        path: `fields.${w.fieldId}`,
        message: `No file ${w.id} uploaded for this answer.`,
      });
    }
  }
  return [...new Set(wanted.map((w) => w.id))];
}

/**
 * Announces a submitter's file for an attachment field on the form: the hardened upload
 * of (the server's key, a presigned PUT for exactly this size and type), at most
 * MAX_FORM_UPLOAD_BYTES, recorded against the link so only its next submission can use it.
 */
export async function createFormUpload(
  form: LoadedForm,
  storeOrNone: ObjectStore | undefined,
  raw: CreateFormUploadInput,
  entitlements: Entitlements
) {
  const input = createFormUploadSchema.parse(raw);
  const field = form.fields.get(input.fieldId);
  if (field?.def.name !== 'attachment' || !form.entries.some((e) => e.fieldId === input.fieldId)) {
    refuse([{ path: 'fieldId', message: 'No file field with this id on the form.' }]);
  }
  if (!storeOrNone) {
    throw new AppError('SERVICE_UNAVAILABLE', { detail: "File storage isn't configured." });
  }
  const { ctx, table } = form;
  // The workspace's attachment storage: the visitor learns which limit, not the usage.
  await withPublicQuota(
    "This form can't take more files right now. Submit it without files, or tell its owner.",
    () => assertAttachmentRoom(ctx.tx, entitlements, ctx.workspaceId, input.size)
  );
  const id = uuidv7();
  const key = storageKey({
    id,
    workspaceId: ctx.workspaceId,
    baseId: table.baseId,
    tableId: table.id,
  });
  const contentType = input.type || 'application/octet-stream';
  const [row] = await ctx.tx
    .insert(attachments)
    .values({
      id,
      workspaceId: ctx.workspaceId,
      baseId: table.baseId,
      tableId: table.id,
      fieldId: field.row.id,
      shareId: ctx.share.id,
      storageKey: key,
      filename: input.filename,
      contentType,
      size: input.size,
      createdBy: null,
    })
    .returning();
  if (!row) throw new Error('form upload insert returned no row');
  const upload = await storeOrNone.presignPut(key, {
    contentType,
    size: input.size,
    expiresIn: ATTACHMENT_UPLOAD_TTL_SECONDS,
  });
  return {
    attachment: toValue(row),
    upload: {
      method: 'PUT' as const,
      ...upload,
      expiresAt: new Date(Date.now() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    },
  };
}

/** Confirms a submitter's upload: only a file of this link that isn't submitted yet. */
export async function confirmFormUpload(
  form: LoadedForm,
  store: ObjectStore | undefined,
  attachmentId: string,
  scanning?: UploadScanning
) {
  const [own] = await form.ctx.tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      and(
        eq(attachments.id, attachmentId),
        eq(attachments.shareId, form.ctx.share.id),
        isNull(attachments.recordId)
      )
    );
  if (!own) throw new AppError('NOT_FOUND', { detail: 'No such file for this form.' });
  return confirmUpload(
    {
      tx: form.ctx.tx,
      workspaceId: form.ctx.workspaceId,
      userId: FORM_SUBJECT.userId,
      table: form.table,
    },
    store,
    attachmentId,
    scanning
  );
}
