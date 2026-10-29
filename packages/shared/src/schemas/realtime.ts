import { z } from 'zod';
import { choiceColorSchema } from '../fields/choices.js';

/**
 * The realtime protocol (ADR-003): JSON text frames on `/ws`. The client subscribes to a
 * table or a view; the server pushes the outbox events of that table (and of its base's
 * structure) as `event` messages, ordered per base by `seq` (the outbox id). A client that sees
 * a gap or reconnects calls `GET /api/bases/:baseId/events?since=<seq>`.
 */

/** Largest client frame the server accepts, in bytes. Bigger frames close the socket (1009). */
export const REALTIME_MAX_MESSAGE_BYTES = 16 * 1024;
/** Subscriptions one socket may hold at once. */
export const REALTIME_MAX_SUBSCRIPTIONS = 50;
/** Events per catch-up page: the default and the cap. */
export const EVENTS_PAGE_DEFAULT = 500;
export const EVENTS_PAGE_MAX = 1000;
/** How long the outbox keeps events (pruned by the worker); older `since` values get 410. */
export const EVENTS_RETENTION_DAYS = 7;

/** What a subscription is for: exactly one of a table or a view. */
export const realtimeTargetSchema = z.union([
  z.strictObject({ tableId: z.uuid() }),
  z.strictObject({ viewId: z.uuid() }),
]);

/**
 * Presence (ADR-003 §8): who else is on a view, the cell they have selected, whether its
 * editor is open and the record they have expanded. Ephemeral: never stored, never in the
 * outbox. A socket publishes its state for a view it is subscribed to; the server shares it
 * with the other users' sockets subscribed to the same view.
 */
/** Presence messages per second a socket may send (a token bucket with twice this burst). */
export const PRESENCE_MESSAGES_PER_SECOND = 10;
/** The longest display name a presence payload carries. */
export const PRESENCE_MAX_NAME = 80;

export const presenceStateSchema = z.strictObject({
  /** The selected cell's record and field, or null for no selection. */
  recordId: z.uuid().nullable(),
  fieldId: z.uuid().nullable(),
  /** A cell editor is open on the selected cell. */
  editing: z.boolean(),
  /** The record open in the record expand view. */
  expandedRecordId: z.uuid().nullable(),
});

export const EMPTY_PRESENCE: PresenceState = {
  recordId: null,
  fieldId: null,
  editing: false,
  expandedRecordId: null,
};

/** Another person on the view, as presence describes them: no email, ever. */
export const PresencePeerSchema = z.strictObject({
  /** One open socket (a tab); a person with two tabs is two peers. Random, not a session id. */
  connectionId: z.uuid(),
  userId: z.uuid(),
  name: z.string().max(PRESENCE_MAX_NAME),
  initials: z.string().max(2),
  color: choiceColorSchema,
  state: presenceStateSchema,
});

/** Messages from the client. Unknown types and extra keys are refused. */
export const realtimeClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('subscribe'), target: realtimeTargetSchema }),
  z.strictObject({ type: z.literal('unsubscribe'), target: realtimeTargetSchema }),
  /** Application-level keepalive (browsers can't send WebSocket pings); answered by `pong`. */
  z.strictObject({ type: z.literal('ping') }),
  /** This socket's presence on a view it is subscribed to (the whole state, latest wins). */
  z.strictObject({ type: z.literal('presence'), viewId: z.uuid(), state: presenceStateSchema }),
]);

/** One outbox event, as pushed on the socket and returned by the catch-up endpoint. */
export const RealtimeEventSchema = z.object({
  /** The outbox id: increasing per base, with gaps (the sequence is shared by every base). */
  seq: z.number().int().nonnegative(),
  baseId: z.uuid(),
  tableId: z.uuid().nullable(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  actorId: z.uuid().nullable(),
  /** The client's id for the operation, so a client can match the echo of its own write. */
  clientOpId: z.string().nullable(),
  at: z.iso.datetime({ offset: true }),
});

/** Why the server refused a message or dropped a subscription. */
export const REALTIME_ERROR_CODES = [
  'BAD_MESSAGE',
  'NOT_FOUND',
  'FORBIDDEN',
  'TOO_MANY_SUBSCRIPTIONS',
  'RATE_LIMITED',
  /** Presence for a view the socket isn't subscribed to (yet). */
  'NOT_SUBSCRIBED',
  'INTERNAL_ERROR',
] as const;

export const realtimeServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), userId: z.uuid() }),
  z.object({
    type: z.literal('subscribed'),
    target: realtimeTargetSchema,
    baseId: z.uuid(),
    tableId: z.uuid(),
    /** Events after this seq arrive on the socket; catch up from your last seq to here. */
    seq: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('unsubscribed'), target: realtimeTargetSchema }),
  z.object({ type: z.literal('event'), event: RealtimeEventSchema }),
  /** Access was lost (removed from the workspace, the table deleted): the subscription is gone. */
  z.object({ type: z.literal('revoked'), target: realtimeTargetSchema }),
  z.object({
    type: z.literal('error'),
    code: z.enum(REALTIME_ERROR_CODES),
    message: z.string(),
    target: realtimeTargetSchema.optional(),
  }),
  z.object({ type: z.literal('pong') }),
  /** Someone joined the view or changed their presence (after `subscribed`: who is there). */
  z.object({ type: z.literal('presence'), viewId: z.uuid(), peer: PresencePeerSchema }),
  /** A socket left the view (closed, unsubscribed, lost access or timed out). */
  z.object({ type: z.literal('presenceLeft'), viewId: z.uuid(), connectionId: z.uuid() }),
  /**
   * Your notifications changed (a new one, or read in another tab): refetch the unread
   * count. Sent to every socket of the recipient, subscribed or not; carries nothing else.
   */
  z.object({ type: z.literal('notifications') }),
]);

/** `GET /api/bases/:baseId/events`. */
export const listEventsQuerySchema = z.strictObject({
  since: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.coerce.number().int().min(1).max(EVENTS_PAGE_MAX).default(EVENTS_PAGE_DEFAULT),
});

export const EventListSchema = z.object({
  events: z.array(RealtimeEventSchema),
  /** Pass as `since` for the next page (the last event's seq, or `since` when empty). */
  next: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export type RealtimeTarget = z.infer<typeof realtimeTargetSchema>;
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>;
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>;
export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
export type PresenceState = z.infer<typeof presenceStateSchema>;
export type PresencePeer = z.infer<typeof PresencePeerSchema>;
export type RealtimeErrorCode = (typeof REALTIME_ERROR_CODES)[number];
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
export type EventList = z.infer<typeof EventListSchema>;
