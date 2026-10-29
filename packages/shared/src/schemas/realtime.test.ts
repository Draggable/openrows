import { describe, expect, it } from 'vitest';
import {
  EMPTY_PRESENCE,
  listEventsQuerySchema,
  PresencePeerSchema,
  realtimeClientMessageSchema,
} from './realtime.js';

const ID = '0190a000-0000-7000-8000-000000000001';

describe('realtime client messages', () => {
  it('accepts subscribe and unsubscribe to exactly one table or view, and ping', () => {
    for (const msg of [
      { type: 'subscribe', target: { tableId: ID } },
      { type: 'subscribe', target: { viewId: ID } },
      { type: 'unsubscribe', target: { tableId: ID } },
      { type: 'ping' },
    ]) {
      expect(realtimeClientMessageSchema.safeParse(msg).success, JSON.stringify(msg)).toBe(true);
    }
  });

  it('refuses unknown types, extra keys, both targets and malformed ids', () => {
    for (const msg of [
      { type: 'publish' },
      { type: 'subscribe', target: { tableId: ID, viewId: ID } },
      { type: 'subscribe', target: { baseId: ID } },
      { type: 'subscribe', target: { tableId: 'nope' } },
      { type: 'subscribe', target: { tableId: ID }, token: 'x' },
      { type: 'ping', extra: 1 },
    ]) {
      expect(realtimeClientMessageSchema.safeParse(msg).success, JSON.stringify(msg)).toBe(false);
    }
  });
});

describe('listEventsQuerySchema', () => {
  it('needs a non-negative since and caps the page size', () => {
    expect(listEventsQuerySchema.parse({ since: '12' })).toEqual({ since: 12, limit: 500 });
    expect(listEventsQuerySchema.safeParse({}).success).toBe(false);
    expect(listEventsQuerySchema.safeParse({ since: '-1' }).success).toBe(false);
    expect(listEventsQuerySchema.safeParse({ since: '0', limit: '1001' }).success).toBe(false);
    expect(listEventsQuerySchema.safeParse({ since: '0', other: 'x' }).success).toBe(false);
  });
});

describe('presence messages (#89)', () => {
  it('accepts a whole presence state for one view', () => {
    const state = { recordId: ID, fieldId: ID, editing: true, expandedRecordId: null };
    expect(
      realtimeClientMessageSchema.safeParse({ type: 'presence', viewId: ID, state }).success
    ).toBe(true);
    expect(
      realtimeClientMessageSchema.safeParse({ type: 'presence', viewId: ID, state: EMPTY_PRESENCE })
        .success
    ).toBe(true);
  });

  it('refuses partial states, extra keys, table targets and malformed ids', () => {
    for (const msg of [
      { type: 'presence', viewId: ID, state: { recordId: ID } },
      { type: 'presence', viewId: ID, state: { ...EMPTY_PRESENCE, cursor: 1 } },
      { type: 'presence', viewId: ID, state: { ...EMPTY_PRESENCE, recordId: 'nope' } },
      { type: 'presence', tableId: ID, state: EMPTY_PRESENCE },
      { type: 'presence', viewId: ID, state: EMPTY_PRESENCE, name: 'Eve' },
    ]) {
      expect(realtimeClientMessageSchema.safeParse(msg).success, JSON.stringify(msg)).toBe(false);
    }
  });

  it('describes a peer without an email', () => {
    const peer = {
      connectionId: ID,
      userId: ID,
      name: 'Ada',
      initials: 'A',
      color: 'blue',
      state: EMPTY_PRESENCE,
    };
    expect(PresencePeerSchema.safeParse(peer).success).toBe(true);
    expect(PresencePeerSchema.safeParse({ ...peer, email: 'a@x.test' }).success).toBe(false);
  });
});
