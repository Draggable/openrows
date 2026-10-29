import type { IDataObject } from 'n8n-workflow';

/** A delivery's JSON body (docs/api/webhooks.md). */
export interface WebhookPayload {
  id: string;
  type: string;
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
  fields?: Record<string, { name: string; type: string }>;
  actor: { id: string; name: string } | null;
}

export function isPayload(value: unknown): value is WebhookPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as IDataObject;
  return typeof p['id'] === 'string' && typeof p['type'] === 'string';
}

/**
 * The trigger's simplified item: the event, its base and table, and for record events the cells
 * by field name (`fields` after the change, `previousFields` before it, `changedFields` for an
 * update), instead of the payload's cells by field id.
 */
export function simplifyPayload(p: WebhookPayload): IDataObject {
  const names = p.fields ?? {};
  const byName = (cells: Record<string, unknown> | null | undefined) =>
    cells
      ? Object.fromEntries(Object.entries(cells).map(([id, v]) => [names[id]?.name ?? id, v]))
      : null;
  const out: IDataObject = {
    event: p.type,
    eventId: p.id,
    timestamp: p.timestamp,
    baseId: p.base?.id ?? null,
    baseName: p.base?.name ?? null,
    tableId: p.table?.id ?? null,
    tableName: p.table?.name ?? null,
  };
  if (p.record) {
    out['recordId'] = p.record.id;
    out['fields'] = byName(p.record.after);
    out['previousFields'] = byName(p.record.before);
    if (p.type === 'record.updated') {
      out['changedFields'] = Object.keys(p.record.after ?? p.record.before ?? {}).map(
        (id) => names[id]?.name ?? id
      );
    }
  }
  if (p.field) out['field'] = p.field;
  out['actor'] = p.actor;
  out['webhookId'] = p.webhookId;
  return out;
}
