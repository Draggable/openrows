import { z } from 'zod';

/**
 * Webhooks: a base's record, field, table and form events, POSTed as signed JSON to a URL
 * the base's creators choose. Managed through the REST API v1 (`webhook:manage`) and the base
 * menu; delivered by the worker through the SSRF-safe client, retried with backoff.
 */
export const WEBHOOK_EVENT_TYPES = [
  'record.created',
  'record.updated',
  'record.deleted',
  'record.restored',
  'field.created',
  'field.updated',
  'field.deleted',
  'field.restored',
  'table.created',
  'table.updated',
  'table.deleted',
  'table.restored',
  'form.submitted',
  'comment.created',
  'comment.updated',
  'comment.deleted',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Webhooks per base, enabled or not. */
export const MAX_WEBHOOKS_PER_BASE = 10;
export const MAX_WEBHOOK_URL_LENGTH = 2048;
export const MAX_WEBHOOK_DESCRIPTION_LENGTH = 200;
export const MAX_WEBHOOK_TABLES = 100;
export const MAX_WEBHOOK_FIELDS = 500;
/** Days the delivery log keeps an attempt. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 7;
/** Characters of a response body the delivery log keeps. */
export const WEBHOOK_RESPONSE_EXCERPT = 1024;
/** The most deliveries one log request returns. */
export const MAX_WEBHOOK_DELIVERIES_PAGE = 100;
/** How old a signature's timestamp a receiver should accept (seconds; documented). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;
export const WEBHOOK_SIGNATURE_HEADER = 'X-OpenRows-Signature';
export const WEBHOOK_EVENT_ID_HEADER = 'X-OpenRows-Event-Id';
export const WEBHOOK_EVENT_TYPE_HEADER = 'X-OpenRows-Event-Type';
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/**
 * After a rotation, the previous secret keeps signing deliveries this long: each request
 * carries a `v1` signature per valid secret, so a receiver can switch over without dropping any.
 */
export const WEBHOOK_SECRET_GRACE_HOURS = 24;

const at = z.iso.datetime({ offset: true });

const webhookUrl = z
  .string()
  .trim()
  .max(MAX_WEBHOOK_URL_LENGTH)
  .pipe(z.url({ protocol: /^https?$/, message: 'Enter an http(s) URL.' }));

const eventTypes = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1, 'Pick at least one event.')
  .max(WEBHOOK_EVENT_TYPES.length)
  .transform((s) => [...new Set(s)]);

/** Null (or absent): every table, every field. */
const ids = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .transform((s) => [...new Set(s)])
    .nullable();

export const createWebhookSchema = z.strictObject({
  url: webhookUrl,
  description: z.string().trim().max(MAX_WEBHOOK_DESCRIPTION_LENGTH).default(''),
  events: eventTypes,
  tableIds: ids(MAX_WEBHOOK_TABLES).default(null),
  fieldIds: ids(MAX_WEBHOOK_FIELDS).default(null),
  enabled: z.boolean().default(true),
});
export type CreateWebhookInput = z.input<typeof createWebhookSchema>;

export const updateWebhookSchema = z
  .strictObject({
    url: webhookUrl.optional(),
    description: z.string().trim().max(MAX_WEBHOOK_DESCRIPTION_LENGTH).optional(),
    events: eventTypes.optional(),
    tableIds: ids(MAX_WEBHOOK_TABLES).optional(),
    fieldIds: ids(MAX_WEBHOOK_FIELDS).optional(),
    /** Enabling again clears the failure count. */
    enabled: z.boolean().optional(),
    /**
     * A new signing secret, returned once in `secret`. The old one still signs deliveries for
     * WEBHOOK_SECRET_GRACE_HOURS (a second `v1` signature), unless `expirePreviousSecret`.
     */
    rotateSecret: z.literal(true).optional(),
    /** Ends the grace period now: only the current secret signs (a leaked old secret). */
    expirePreviousSecret: z.literal(true).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change.' });
export type UpdateWebhookInput = z.input<typeof updateWebhookSchema>;

export const WebhookSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  url: z.string(),
  description: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
  tableIds: z.array(z.uuid()).nullable(),
  fieldIds: z.array(z.uuid()).nullable(),
  enabled: z.boolean(),
  /** Why the server turned it off: too many failures, or its creator lost access to the base. */
  disabledReason: z.enum(['failures', 'creator_access']).nullable(),
  consecutiveFailures: z.number().int(),
  lastDeliveryAt: at.nullable(),
  lastSuccess: z.boolean().nullable(),
  /**
   * Until when the secret before the last rotation still signs deliveries; null when only
   * the current one does.
   */
  previousSecretExpiresAt: at.nullable(),
  /** Whose access the payloads honour. */
  createdBy: z.uuid().nullable(),
  createdAt: at,
  updatedAt: at,
});
export type Webhook = z.infer<typeof WebhookSchema>;

/** A webhook with its signing secret: only the answer to a creation or a rotation. */
export const WebhookWithSecretSchema = WebhookSchema.extend({ secret: z.string().optional() });
export type WebhookWithSecret = z.infer<typeof WebhookWithSecretSchema>;

export const WebhookListSchema = z.object({ webhooks: z.array(WebhookSchema) });
export type WebhookList = z.infer<typeof WebhookListSchema>;

/** One delivery attempt, newest first in the log. */
export const WebhookDeliverySchema = z.object({
  id: z.uuid(),
  eventId: z.string(),
  /** A webhook event type, or `ping` for a test. */
  eventType: z.string(),
  attempt: z.number().int(),
  success: z.boolean(),
  responseStatus: z.number().int().nullable(),
  durationMs: z.number().int(),
  /** The response body's first characters (`WEBHOOK_RESPONSE_EXCERPT`). */
  responseBody: z.string().nullable(),
  /** Why there was no response. */
  error: z.string().nullable(),
  createdAt: at,
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const WebhookDeliveryListSchema = z.object({ deliveries: z.array(WebhookDeliverySchema) });

/** The answer to a redelivery: the event goes back in the queue for the worker. */
export const WebhookRedeliverySchema = z.object({ queued: z.literal(true), eventId: z.string() });
export type WebhookRedelivery = z.infer<typeof WebhookRedeliverySchema>;
export type WebhookDeliveryList = z.infer<typeof WebhookDeliveryListSchema>;

export const webhookDeliveriesQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_WEBHOOK_DELIVERIES_PAGE).default(50),
});

/** A field as a payload names it. */
export interface WebhookPayloadField {
  name: string;
  type: string;
}

/**
 * The JSON body of a delivery. `record.before`/`after` hold cells by field id (`fields` names
 * them): every cell for a created record, the changed ones for an update, every cell before a
 * deletion. Fields the webhook's creator can't read are left out.
 */
export interface WebhookPayload {
  /** The same as `X-OpenRows-Event-Id`: identical for every retry of one event. */
  id: string;
  type: WebhookEventType | 'ping';
  timestamp: string;
  webhookId: string;
  base: { id: string; name: string };
  table: { id: string; name: string } | null;
  record?: {
    id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
  field?: { id: string; name: string; type: string } | null;
  fields?: Record<string, WebhookPayloadField>;
  /**
   * A comment event's comment: its record and, unless deleted, its body (sanitized
   * Markdown with `@[name](user:<id>)` mention tokens) and author.
   */
  comment?: {
    id: string;
    recordId: string;
    body: string | null;
    authorId: string | null;
    mentions: string[];
    createdAt: string | null;
    editedAt: string | null;
  };
  /** Who made the change; null for a public form or the system. */
  actor: { id: string; name: string } | null;
}
