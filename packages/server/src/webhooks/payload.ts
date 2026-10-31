import type {
  UserRole,
  WebhookEventType,
  WebhookPayload,
  WebhookPayloadField,
} from '@openrows/shared';
import { eq, inArray } from 'drizzle-orm';
import type { OutboxRow } from '../data/outbox.js';
import { bases, fields, type Transaction, tables, users } from '../db/index.js';
import type { FieldVisibility } from '../realtime/projection.js';
import type { WebhookRow } from './service.js';

type Payload = Record<string, unknown>;

function isObject(v: unknown): v is Payload {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cellsOf(v: unknown, hidden: ReadonlySet<string>): Record<string, unknown> | null {
  if (!isObject(v)) return null;
  return Object.fromEntries(Object.entries(v).filter(([id]) => !hidden.has(id)));
}

/**
 * The webhook event type an outbox event is for this webhook, or null when it doesn't want it:
 * a form's submission is `form.submitted` when subscribed (else `record.created`), computed-only
 * record updates aren't delivered, and `fieldIds` keeps only record updates touching them.
 */
export function webhookEventType(
  webhook: Pick<WebhookRow, 'events' | 'tableIds' | 'fieldIds'>,
  event: Pick<OutboxRow, 'kind' | 'tableId' | 'payload'>
): WebhookEventType | null {
  const wants = new Set(webhook.events);
  const payload = isObject(event.payload) ? event.payload : {};
  if (webhook.tableIds && (event.tableId === null || !webhook.tableIds.includes(event.tableId))) {
    return null;
  }
  switch (event.kind) {
    case 'record.created':
      if (payload['via'] === 'form' && wants.has('form.submitted')) return 'form.submitted';
      return wants.has('record.created') ? 'record.created' : null;
    case 'record.updated': {
      if (!wants.has('record.updated') || payload['computed'] === true) return null;
      // No field filter, null or empty: an update of any field.
      if (!webhook.fieldIds?.length) return 'record.updated';
      const changed = Array.isArray(payload['fieldIds']) ? payload['fieldIds'] : [];
      return changed.some((id) => webhook.fieldIds?.includes(String(id))) ? 'record.updated' : null;
    }
    case 'record.deleted':
    case 'record.restored':
    case 'field.created':
    case 'field.updated':
    case 'field.deleted':
    case 'field.restored':
    case 'table.created':
    case 'table.updated':
    case 'table.deleted':
    case 'table.restored':
    case 'comment.created':
    case 'comment.updated':
    case 'comment.deleted':
      return wants.has(event.kind) ? event.kind : null;
    default:
      return null;
  }
}

/**
 * The JSON a webhook receives for one outbox event, as the webhook's creator may see it (fields
 * they can't read are left out, `FieldVisibility`), or null when there's nothing to send.
 * Reads names (base, table, fields, actor) as they are now; trashed tables and fields still
 * name themselves.
 */
export async function buildWebhookPayload(
  tx: Transaction,
  args: {
    webhook: WebhookRow;
    event: OutboxRow;
    eventId: string;
    viewer: { userId: string; role: UserRole };
    visibility: FieldVisibility;
  }
): Promise<WebhookPayload | null> {
  const { webhook, event, eventId, viewer, visibility } = args;
  const type = webhookEventType(webhook, event);
  if (!type) return null;
  const payload = isObject(event.payload) ? event.payload : {};
  const hidden = event.tableId ? visibility.hiddenFields(viewer, event.tableId) : new Set<string>();

  const [base] = await tx
    .select({ id: bases.id, name: bases.name })
    .from(bases)
    .where(eq(bases.id, webhook.baseId));
  if (!base) return null;
  let table: WebhookPayload['table'] = null;
  if (event.tableId) {
    const [row] = await tx
      .select({ id: tables.id, name: tables.name })
      .from(tables)
      .where(eq(tables.id, event.tableId));
    table = row ?? { id: event.tableId, name: '' };
  }
  let actor: WebhookPayload['actor'] = null;
  if (event.actorId) {
    const [user] = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, event.actorId));
    actor = { id: event.actorId, name: user?.name ?? '' };
  }
  const out: WebhookPayload = {
    id: eventId,
    type,
    timestamp: event.createdAt.toISOString(),
    webhookId: webhook.id,
    base,
    table,
    actor,
  };

  if (event.kind.startsWith('record.')) {
    const recordId = String(payload['recordId'] ?? '');
    let before: Record<string, unknown> | null = null;
    let after: Record<string, unknown> | null = null;
    if (event.kind === 'record.created' || event.kind === 'record.restored') {
      const record = payload['record'];
      after = cellsOf(isObject(record) ? record['fields'] : null, hidden) ?? {};
    } else if (event.kind === 'record.updated') {
      after = cellsOf(payload['cells'], hidden) ?? {};
      before = cellsOf(payload['before'], hidden);
      if (Object.keys(after).length === 0) return null;
    } else {
      before = cellsOf(payload['before'], hidden);
    }
    out.record = { id: recordId, before, after };
    const ids = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
    out.fields = await fieldNames(tx, ids);
    return out;
  }

  if (event.kind.startsWith('comment.')) {
    const comment = isObject(payload['comment']) ? payload['comment'] : null;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    out.comment = {
      id: String(comment?.['id'] ?? payload['commentId'] ?? ''),
      recordId: String(payload['recordId'] ?? ''),
      body: str(comment?.['body']),
      authorId: str(comment?.['authorId']),
      mentions: Array.isArray(comment?.['mentions']) ? comment['mentions'].map(String) : [],
      createdAt: str(comment?.['createdAt']),
      editedAt: str(comment?.['editedAt']),
    };
    return out;
  }

  if (event.kind.startsWith('field.')) {
    const field = payload['field'];
    const fieldId = isObject(field) ? String(field['id'] ?? '') : String(payload['fieldId'] ?? '');
    if (!fieldId || hidden.has(fieldId)) return null;
    const named = (await fieldNames(tx, [fieldId]))[fieldId];
    out.field = {
      id: fieldId,
      name: isObject(field) ? String(field['name'] ?? '') : (named?.name ?? ''),
      type: isObject(field) ? String(field['type'] ?? '') : (named?.type ?? ''),
    };
  }
  return out;
}

async function fieldNames(
  tx: Transaction,
  ids: string[]
): Promise<Record<string, WebhookPayloadField>> {
  if (ids.length === 0) return {};
  const rows = await tx
    .select({ id: fields.id, name: fields.name, type: fields.type })
    .from(fields)
    .where(inArray(fields.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, { name: r.name, type: r.type }]));
}
