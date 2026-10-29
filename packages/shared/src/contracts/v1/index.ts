import { z } from 'zod';
import { MAX_COMMENT_LENGTH } from '../../comments.js';
import { MAX_FORMULA_LENGTH } from '../../formula/ast.js';
import { MAX_SORTS } from '../../query/index.js';
import {
  AutomationRunListSchema,
  automationRunsQuerySchema,
  V1AutomationListSchema,
  V1AutomationSchema,
  V1AutomationTriggeredSchema,
  v1TriggerAutomationSchema,
  v1UpdateAutomationSchema,
} from '../../schemas/automation.js';
import {
  createWebhookSchema,
  updateWebhookSchema,
  WebhookDeliveryListSchema,
  WebhookDeliverySchema,
  WebhookListSchema,
  WebhookRedeliverySchema,
  WebhookWithSecretSchema,
  webhookDeliveriesQuerySchema,
} from '../../schemas/webhook.js';
import { defineEndpoint as e } from '../endpoint.js';

/**
 * The public REST API v1: Airtable's Web API shape under `/api/v1`, for integrators and
 * people moving from Airtable (the official `airtable` client works with `endpointUrl` set to
 * `<app>/api` and `apiVersion: '1.0.0'`). Tables are named by id or name, record fields by name
 * (or id with `returnFieldsByFieldId`), errors are `{ error: { type, message } }`. Ids are
 * OpenRows' UUIDs (Airtable's `app…`, `tbl…`, `fld…`, `rec…` prefixes aren't used).
 */

/** Largest page of records or comments (Airtable's limit). */
export const V1_PAGE_SIZE_MAX = 100;
/** Most records one create, update or delete takes (Airtable's limit). */
export const V1_BATCH_MAX = 10;
/** Most fields one table creation takes. */
export const V1_TABLE_FIELDS_MAX = 100;

const name = z.string().trim().min(1).max(255);
const flag = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

/** List parameters, as a JSON body (`POST .../listRecords`) or parsed from the query string. */
export const v1ListParamsSchema = z
  .object({
    pageSize: z.coerce.number().int().min(1).max(V1_PAGE_SIZE_MAX).optional(),
    /** The previous page's `offset`. */
    offset: z.string().min(1).max(10_000).optional(),
    maxRecords: z.coerce.number().int().min(1).max(10_000_000).optional(),
    /** A view of the table, by id or name: its records, in its order (unless `sort`). */
    view: z.string().min(1).max(255).optional(),
    /** Only these fields (names or ids). */
    fields: z.array(z.string().min(1).max(255)).max(500).optional(),
    sort: z
      .array(
        z
          .object({
            field: z.string().min(1).max(255),
            direction: z.enum(['asc', 'desc']).optional(),
          })
          .strict()
      )
      .max(MAX_SORTS)
      .optional(),
    /** A formula; only what compiles to SQL is supported (else 422 INVALID_FILTER_BY_FORMULA). */
    filterByFormula: z.string().max(MAX_FORMULA_LENGTH).optional(),
    cellFormat: z.enum(['json', 'string']).default('json'),
    /** IANA zone for date filters (`TODAY()`) and `cellFormat=string`. */
    timeZone: z.string().max(64).optional(),
    userLocale: z.string().max(35).optional(),
    returnFieldsByFieldId: flag.default(false),
    recordMetadata: z.array(z.literal('commentCount')).max(1).optional(),
  })
  .strict();
export type V1ListParams = z.output<typeof v1ListParamsSchema>;

const SORT_KEY = /^sort\[(\d{1,2})\]\[(field|direction)\]$/;
const LIST_KEY = /^(fields|recordMetadata)(\[\d{0,3}\])?$/;

/**
 * Airtable's query string (`fields[]=A&sort[0][field]=B&sort[0][direction]=desc`), each key with
 * all its values, as list parameters.
 */
export function listParamsFromQuery(query: Record<string, string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sorts = new Map<number, Record<string, string>>();
  for (const [key, values] of Object.entries(query)) {
    const sort = SORT_KEY.exec(key);
    const list = LIST_KEY.exec(key);
    if (sort) {
      const index = Number(sort[1]);
      const entry = sorts.get(index) ?? {};
      entry[sort[2] as string] = values.at(-1) ?? '';
      sorts.set(index, entry);
    } else if (list) {
      const k = list[1] as string;
      out[k] = [...((out[k] as string[] | undefined) ?? []), ...values];
    } else {
      out[key] = values.at(-1);
    }
  }
  if (sorts.size) out['sort'] = [...sorts.entries()].sort((a, b) => a[0] - b[0]).map((s) => s[1]);
  return out;
}

const queryValues = z.array(z.string().max(MAX_FORMULA_LENGTH)).max(500).optional();

/** `GET /api/v1/:baseId/:table`'s query string, every key with all its values. */
export const v1ListQuerySchema = z
  .looseObject({
    pageSize: queryValues,
    offset: queryValues,
    maxRecords: queryValues,
    view: queryValues,
    'fields[]': queryValues,
    'sort[0][field]': queryValues,
    'sort[0][direction]': queryValues,
    filterByFormula: queryValues,
    cellFormat: queryValues,
    timeZone: queryValues,
    userLocale: queryValues,
    returnFieldsByFieldId: queryValues,
    'recordMetadata[]': queryValues,
  })
  .transform((q) => listParamsFromQuery(q as Record<string, string[]>))
  .pipe(v1ListParamsSchema);

/** A record's cells by field name (or id). */
const cellsInput = z
  .record(z.string().min(1).max(255), z.unknown())
  .refine((cells) => Object.keys(cells).length <= 500, 'At most 500 fields.');

const writeOptions = {
  /** Read values as Airtable's typecast does: new select options, linked records by name. */
  typecast: z.boolean().optional(),
  returnFieldsByFieldId: z.boolean().optional(),
};

export const v1CreateRecordsSchema = z.union([
  z
    .object({
      records: z
        .array(z.object({ fields: cellsInput }).strict())
        .min(1)
        .max(V1_BATCH_MAX),
      ...writeOptions,
    })
    .strict(),
  z.object({ fields: cellsInput, ...writeOptions }).strict(),
]);

/** `PATCH`/`PUT` of up to 10 records; with `performUpsert`, records without an id are matched. */
export const v1UpdateRecordsSchema = z
  .object({
    records: z
      .array(z.object({ id: z.uuid().optional(), fields: cellsInput }).strict())
      .min(1)
      .max(V1_BATCH_MAX),
    performUpsert: z
      .object({ fieldsToMergeOn: z.array(z.string().min(1).max(255)).min(1).max(3) })
      .strict()
      .optional(),
    ...writeOptions,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.performUpsert) return;
    body.records.forEach((r, i) => {
      if (!r.id) ctx.addIssue({ code: 'custom', path: ['records', i, 'id'], message: 'Required.' });
    });
  });

export const v1UpdateRecordSchema = z.object({ fields: cellsInput, ...writeOptions }).strict();

/** `DELETE /api/v1/:baseId/:table?records[]=…`. */
export const v1DeleteRecordsQuerySchema = z
  .looseObject({ 'records[]': z.array(z.uuid()).optional(), records: z.array(z.uuid()).optional() })
  .transform((q) => ({ records: [...(q['records[]'] ?? []), ...(q.records ?? [])] }))
  .pipe(z.object({ records: z.array(z.uuid()).min(1).max(V1_BATCH_MAX) }));

export const V1RecordSchema = z.object({
  id: z.string(),
  createdTime: z.string(),
  /** Non-empty cells only, as Airtable answers. */
  fields: z.record(z.string(), z.unknown()),
  commentCount: z.int().optional(),
});
export type V1Record = z.infer<typeof V1RecordSchema>;

export const V1RecordListSchema = z.object({
  records: z.array(V1RecordSchema),
  offset: z.string().optional(),
});

export const V1RecordsSchema = z.object({
  records: z.array(V1RecordSchema),
  /** With `performUpsert`: the ids created and updated. */
  createdRecords: z.array(z.string()).optional(),
  updatedRecords: z.array(z.string()).optional(),
});

export const V1DeletedRecordSchema = z.object({ id: z.string(), deleted: z.literal(true) });
export const V1DeletedRecordsSchema = z.object({ records: z.array(V1DeletedRecordSchema) });

export const v1CommentsQuerySchema = z
  .object({
    pageSize: z.coerce.number().int().min(1).max(V1_PAGE_SIZE_MAX).optional(),
    offset: z.string().max(100).optional(),
  })
  .strict();

export const v1CreateCommentSchema = z
  .object({
    text: z
      .string()
      .max(MAX_COMMENT_LENGTH)
      .refine((s) => s.trim().length > 0, 'A comment needs some text.'),
  })
  .strict();

const V1CollaboratorSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  name: z.string().optional(),
});

export const V1CommentSchema = z.object({
  id: z.string(),
  author: V1CollaboratorSchema,
  text: z.string(),
  createdTime: z.string(),
  lastUpdatedTime: z.string().nullable(),
});

export const V1CommentListSchema = z.object({
  comments: z.array(V1CommentSchema),
  offset: z.string().nullable(),
});

/** Airtable's names for our roles. */
export const V1_PERMISSION_LEVELS = ['read', 'comment', 'edit', 'create', 'owner'] as const;

export const V1BaseListSchema = z.object({
  bases: z.array(
    z.object({ id: z.string(), name: z.string(), permissionLevel: z.enum(V1_PERMISSION_LEVELS) })
  ),
});

export const V1FieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Airtable's type name where it differs from ours (`multipleRecordLinks`). */
  type: z.string(),
  /** OpenRows' own type name. */
  openrowsType: z.string(),
  description: z.string().optional(),
  options: z.unknown().optional(),
});

export const V1ViewSchema = z.object({ id: z.string(), name: z.string(), type: z.string() });

export const V1TableSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  primaryFieldId: z.string(),
  fields: z.array(V1FieldSchema),
  views: z.array(V1ViewSchema),
});

export const V1TableListSchema = z.object({ tables: z.array(V1TableSchema) });

/** A field to create: `type` is ours or Airtable's name for it. */
export const v1CreateFieldSchema = z
  .object({
    name,
    type: z.string().min(1).max(64),
    description: z.string().max(2000).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const v1CreateTableSchema = z
  .object({
    name,
    description: z.string().max(2000).optional(),
    /** The first field becomes the primary field. */
    fields: z.array(v1CreateFieldSchema).min(1).max(V1_TABLE_FIELDS_MAX),
  })
  .strict();

export const v1UpdateFieldSchema = z
  .object({ name: name.optional(), description: z.string().max(2000).nullable().optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.description !== undefined, 'Nothing to change.');

const baseId = { baseId: z.uuid() };
const recordParams = { baseId: z.uuid(), recordId: z.uuid() };
const webhookParams = { baseId: z.uuid(), webhookId: z.uuid() };
const automationParams = { baseId: z.uuid(), automationId: z.uuid() };
const TABLE = '/api/v1/:baseId/:tableIdOrName';

export const v1Contracts = {
  v1Meta: {
    bases: e({
      method: 'GET',
      path: '/api/v1/meta/bases',
      summary: 'Bases the caller (and token) can read, with their permission level',
      tag: 'v1',
      query: z.object({ offset: z.string().max(100).optional() }).strict(),
      response: V1BaseListSchema,
      status: 200,
    }),
    tables: e({
      method: 'GET',
      path: '/api/v1/meta/bases/:baseId/tables',
      summary: "A base's tables with their fields (types and options) and views",
      tag: 'v1',
      params: baseId,
      response: V1TableListSchema,
      status: 200,
    }),
    createTable: e({
      method: 'POST',
      path: '/api/v1/meta/bases/:baseId/tables',
      summary: 'Create a table with its fields (the first is the primary field)',
      tag: 'v1',
      params: baseId,
      body: v1CreateTableSchema,
      response: V1TableSchema,
      status: 200,
    }),
    createField: e({
      method: 'POST',
      path: '/api/v1/meta/bases/:baseId/tables/:tableIdOrName/fields',
      summary: 'Create a field',
      tag: 'v1',
      params: baseId,
      body: v1CreateFieldSchema,
      response: V1FieldSchema,
      status: 200,
    }),
    updateField: e({
      method: 'PATCH',
      path: '/api/v1/meta/bases/:baseId/tables/:tableIdOrName/fields/:fieldId',
      summary: 'Rename a field or change its description',
      tag: 'v1',
      params: { baseId: z.uuid(), fieldId: z.uuid() },
      body: v1UpdateFieldSchema,
      response: V1FieldSchema,
      status: 200,
    }),
  },
  v1Records: {
    list: e({
      method: 'GET',
      path: TABLE,
      summary: 'List records: pageSize, offset, maxRecords, view, sort, fields, filterByFormula',
      tag: 'v1',
      params: baseId,
      query: v1ListQuerySchema,
      queryArrays: true,
      response: V1RecordListSchema,
      status: 200,
    }),
    listPost: e({
      method: 'POST',
      path: `${TABLE}/listRecords`,
      summary: 'List records with the parameters in the body (for long formulas)',
      tag: 'v1',
      params: baseId,
      body: v1ListParamsSchema,
      response: V1RecordListSchema,
      status: 200,
    }),
    create: e({
      method: 'POST',
      path: TABLE,
      summary: 'Create one record (`fields`) or up to 10 (`records`)',
      tag: 'v1',
      params: baseId,
      body: v1CreateRecordsSchema,
      response: z.union([V1RecordsSchema, V1RecordSchema]),
      status: 200,
    }),
    updateMany: e({
      method: 'PATCH',
      path: TABLE,
      summary: 'Update up to 10 records (or upsert with performUpsert)',
      tag: 'v1',
      params: baseId,
      body: v1UpdateRecordsSchema,
      response: V1RecordsSchema,
      status: 200,
    }),
    replaceMany: e({
      method: 'PUT',
      path: TABLE,
      summary: 'Replace up to 10 records: fields left out are cleared',
      tag: 'v1',
      params: baseId,
      body: v1UpdateRecordsSchema,
      response: V1RecordsSchema,
      status: 200,
    }),
    deleteMany: e({
      method: 'DELETE',
      path: TABLE,
      summary: 'Delete up to 10 records (`records[]`), to the trash',
      tag: 'v1',
      params: baseId,
      query: v1DeleteRecordsQuerySchema,
      queryArrays: true,
      response: V1DeletedRecordsSchema,
      status: 200,
    }),
    get: e({
      method: 'GET',
      path: `${TABLE}/:recordId`,
      summary: 'One record',
      tag: 'v1',
      params: recordParams,
      query: z
        .object({
          cellFormat: z.enum(['json', 'string']).default('json'),
          returnFieldsByFieldId: flag.default(false),
          timeZone: z.string().max(64).optional(),
          userLocale: z.string().max(35).optional(),
        })
        .strict(),
      response: V1RecordSchema,
      status: 200,
    }),
    update: e({
      method: 'PATCH',
      path: `${TABLE}/:recordId`,
      summary: 'Update a record: only the fields given change',
      tag: 'v1',
      params: recordParams,
      body: v1UpdateRecordSchema,
      response: V1RecordSchema,
      status: 200,
    }),
    replace: e({
      method: 'PUT',
      path: `${TABLE}/:recordId`,
      summary: 'Replace a record: fields left out are cleared',
      tag: 'v1',
      params: recordParams,
      body: v1UpdateRecordSchema,
      response: V1RecordSchema,
      status: 200,
    }),
    delete: e({
      method: 'DELETE',
      path: `${TABLE}/:recordId`,
      summary: 'Delete a record (to the trash)',
      tag: 'v1',
      params: recordParams,
      response: V1DeletedRecordSchema,
      status: 200,
    }),
  },
  v1Comments: {
    list: e({
      method: 'GET',
      path: `${TABLE}/:recordId/comments`,
      summary: "A record's comments, newest first",
      tag: 'v1',
      params: recordParams,
      query: v1CommentsQuerySchema,
      response: V1CommentListSchema,
      status: 200,
    }),
    create: e({
      method: 'POST',
      path: `${TABLE}/:recordId/comments`,
      summary: 'Comment on a record',
      tag: 'v1',
      params: recordParams,
      body: v1CreateCommentSchema,
      response: V1CommentSchema,
      status: 200,
    }),
  },
  // Webhooks: `webhook:manage` and the base's creator role. Listed before the record
  // routes, whose `/api/v1/:baseId/:tableIdOrName/:recordId` would match the list's path too.
  v1Webhooks: {
    list: e({
      method: 'GET',
      path: '/api/v1/bases/:baseId/webhooks',
      summary: "A base's webhooks (never their secrets)",
      tag: 'v1',
      params: baseId,
      response: WebhookListSchema,
      status: 200,
    }),
    create: e({
      method: 'POST',
      path: '/api/v1/bases/:baseId/webhooks',
      summary: 'Create a webhook; the answer holds its signing secret, shown only this once',
      tag: 'v1',
      params: baseId,
      body: createWebhookSchema,
      response: WebhookWithSecretSchema,
      status: 201,
    }),
    update: e({
      method: 'PATCH',
      path: '/api/v1/bases/:baseId/webhooks/:webhookId',
      summary: 'Change, enable or disable a webhook, or rotate its secret (returned once)',
      tag: 'v1',
      params: webhookParams,
      body: updateWebhookSchema,
      response: WebhookWithSecretSchema,
      status: 200,
    }),
    delete: e({
      method: 'DELETE',
      path: '/api/v1/bases/:baseId/webhooks/:webhookId',
      summary: 'Delete a webhook and its delivery log',
      tag: 'v1',
      params: webhookParams,
      response: null,
      status: 204,
    }),
    deliveries: e({
      method: 'GET',
      path: '/api/v1/bases/:baseId/webhooks/:webhookId/deliveries',
      summary: "A webhook's delivery attempts of the last 7 days, newest first",
      tag: 'v1',
      params: webhookParams,
      query: webhookDeliveriesQuerySchema,
      response: WebhookDeliveryListSchema,
      status: 200,
    }),
    ping: e({
      method: 'POST',
      path: '/api/v1/bases/:baseId/webhooks/:webhookId/ping',
      summary: 'Send a signed test event now and answer with the attempt',
      tag: 'v1',
      params: webhookParams,
      response: WebhookDeliverySchema,
      status: 200,
    }),
    redeliver: e({
      method: 'POST',
      path: '/api/v1/bases/:baseId/webhooks/:webhookId/deliveries/:deliveryId/redeliver',
      summary: "Queue a logged delivery's event again, with the same event id",
      tag: 'v1',
      params: { ...webhookParams, deliveryId: z.uuid() },
      response: WebhookRedeliverySchema,
      status: 200,
    }),
  },
  // Automations: the base's creators, with `automations:read`, `automations:manage` (on
  // and off) and `automations:run` (trigger). Building them stays in the app. Listed before the
  // record routes, like the webhooks.
  v1Automations: {
    list: e({
      method: 'GET',
      path: '/api/v1/bases/:baseId/automations',
      summary: "A base's automations (never their webhook URLs)",
      tag: 'v1',
      params: baseId,
      response: V1AutomationListSchema,
      status: 200,
    }),
    get: e({
      method: 'GET',
      path: '/api/v1/bases/:baseId/automations/:automationId',
      summary: 'One automation: its trigger, actions and last run',
      tag: 'v1',
      params: automationParams,
      response: V1AutomationSchema,
      status: 200,
    }),
    update: e({
      method: 'PATCH',
      path: '/api/v1/bases/:baseId/automations/:automationId',
      summary: 'Turn an automation on or off; turning it on makes it run as you',
      tag: 'v1',
      params: automationParams,
      body: v1UpdateAutomationSchema,
      response: V1AutomationSchema,
      status: 200,
    }),
    runs: e({
      method: 'GET',
      path: '/api/v1/bases/:baseId/automations/:automationId/runs',
      summary: "An automation's runs of the last 30 days, newest first",
      tag: 'v1',
      params: automationParams,
      query: automationRunsQuerySchema,
      response: AutomationRunListSchema,
      status: 200,
    }),
    trigger: e({
      method: 'POST',
      path: '/api/v1/bases/:baseId/automations/:automationId/trigger',
      summary: 'Trigger a webhook-received (`body`) or button-clicked (`recordId`) automation',
      tag: 'v1',
      params: automationParams,
      body: v1TriggerAutomationSchema,
      response: V1AutomationTriggeredSchema,
      status: 200,
    }),
  },
} as const;
