import type { RealtimeEvent, UserRole } from '@openrows/shared';
import type { OutboxRow } from '../data/outbox.js';

/** Who receives an event: the same principal and role REST would check. */
export interface Viewer {
  userId: string;
  role: UserRole;
}

/**
 * Field-level visibility (ADR-003 §6): the fields of a table a viewer may not read. Events and
 * catch-up pages drop them, as REST will. Nothing is restricted per field yet; field and table
 * permissions plug in here.
 */
export interface FieldVisibility {
  hiddenFields(viewer: Viewer, tableId: string): ReadonlySet<string>;
}

/** Outbox kinds for the server only. */
const INTERNAL_KINDS: ReadonlySet<string> = new Set([
  'comment.mentioned',
  'form.submitted',
  'ai.requested',
]);

const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

export const allFieldsVisible: FieldVisibility = {
  hiddenFields: () => NOTHING_HIDDEN,
};

type Payload = Record<string, unknown>;

function isObject(v: unknown): v is Payload {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function withoutKeys(obj: Payload, hidden: ReadonlySet<string>): Payload {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !hidden.has(k)));
}

/** A record event without the hidden fields; null when nothing visible is left of an update. */
function projectRecord(kind: string, payload: Payload, hidden: ReadonlySet<string>) {
  if (hidden.size === 0) return payload;
  const out: Payload = { ...payload };
  if (Array.isArray(out['fieldIds'])) {
    out['fieldIds'] = out['fieldIds'].filter((id) => typeof id === 'string' && !hidden.has(id));
  }
  if (isObject(out['cells'])) out['cells'] = withoutKeys(out['cells'], hidden);
  const record = out['record'];
  if (isObject(record) && isObject(record['fields'])) {
    out['record'] = { ...record, fields: withoutKeys(record['fields'], hidden) };
  }
  if (kind === 'record.updated' && Array.isArray(out['fieldIds']) && out['fieldIds'].length === 0) {
    return null;
  }
  return out;
}

function fieldIdOf(payload: Payload): string | undefined {
  const field = payload['field'];
  if (isObject(field) && typeof field['id'] === 'string') return field['id'];
  return typeof payload['fieldId'] === 'string' ? payload['fieldId'] : undefined;
}

/**
 * The event as `viewer` may see it, or null when they may not see it at all. The one filter
 * between the outbox and a client, for the socket and the catch-up endpoint alike:
 * - a personal view's events reach only its owner (`personalTo`), as `visibleTo` does in
 *   REST; the audience marker itself is stripped;
 * - hidden fields (`FieldVisibility`) are removed from record events, and their field events
 *   dropped;
 * - internal events (`comment.mentioned`; `form.submitted`) are dropped.
 */
export function projectEvent(
  row: OutboxRow,
  viewer: Viewer,
  visibility: FieldVisibility = allFieldsVisible
): RealtimeEvent | null {
  if (row.baseId === null) return null;
  // Internal domain events (notifications consume them) never reach a client.
  if (INTERNAL_KINDS.has(row.kind)) return null;
  let payload: Payload | null = isObject(row.payload) ? row.payload : {};
  if (row.kind.startsWith('view.')) {
    const { personalTo, ...rest } = payload;
    if (typeof personalTo === 'string' && personalTo !== viewer.userId) return null;
    payload = rest;
  }
  if (row.kind.startsWith('record.') && 'before' in payload) {
    // Cells before an update or a deletion are for webhooks, not clients.
    const { before: _before, ...rest } = payload;
    payload = rest;
  }
  if (row.tableId !== null) {
    const hidden = visibility.hiddenFields(viewer, row.tableId);
    if (row.kind.startsWith('record.')) {
      payload = projectRecord(row.kind, payload, hidden);
    } else if (row.kind.startsWith('field.')) {
      const id = fieldIdOf(payload);
      if (id !== undefined && hidden.has(id)) payload = null;
    }
  }
  if (payload === null) return null;
  return {
    seq: row.id,
    baseId: row.baseId,
    tableId: row.tableId,
    kind: row.kind,
    payload,
    actorId: row.actorId,
    clientOpId: row.clientOpId,
    at: row.createdAt.toISOString(),
  };
}
