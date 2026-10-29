import type { EventList, RealtimeEvent, RealtimeServerMessage } from '@openrows/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_BASE_MS,
  type ConnectionDeps,
  DEAD_AFTER_MS,
  IDLE_CLOSE_MS,
  PING_EVERY_MS,
  PRESENCE_EVERY_MS,
  RealtimeConnection,
} from './connection';

const BASE = '0190a000-0000-7000-8000-00000000000b';
const TABLE = '0190a000-0000-7000-8000-00000000000a';
const OTHER_TABLE = '0190a000-0000-7000-8000-00000000000c';
const OTHER_BASE = '0190a000-0000-7000-8000-00000000000d';

/** A fake WebSocket: records what the client sent, and lets the test play the server. */
class FakeSocket {
  sent: unknown[] = [];
  closed: number | undefined;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
  }
  /** The server sends `message`. */
  receive(message: RealtimeServerMessage) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
  /** The server (or the network) closes the socket. */
  drop(code = 1006) {
    this.onclose?.(new CloseEvent('close', { code }));
  }
}

const event = (seq: number, tableId = TABLE): RealtimeEvent => ({
  seq,
  baseId: BASE,
  tableId,
  kind: 'record.updated',
  payload: { recordId: '0190a000-0000-7000-8000-000000000001', cells: { f: seq } },
  actorId: null,
  clientOpId: null,
  at: '2026-10-26T10:00:00.000Z',
});

function setup(overrides: Partial<ConnectionDeps> = {}) {
  const sockets: FakeSocket[] = [];
  const delivered: number[] = [];
  const resyncs: string[] = [];
  const pages = new Map<number, EventList | 'expired'>();
  const fetchEvents = vi.fn(async (_baseId: string, since: number) => {
    return pages.get(since) ?? { events: [], next: since, hasMore: false };
  });
  const conn = new RealtimeConnection({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    fetchEvents,
    onEvents: (events) => delivered.push(...events.map((e) => e.seq)),
    onResync: (baseId) => resyncs.push(baseId),
    random: () => 1,
    ...overrides,
  });
  const socket = () => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  /** Plays the server's handshake on the latest socket: ready, then `subscribed` at `seq`. */
  const handshake = (seq: number, tableId = TABLE) => {
    socket().receive({ type: 'ready', userId: '0190a000-0000-7000-8000-0000000000ff' });
    socket().receive({ type: 'subscribed', target: { tableId }, baseId: BASE, tableId, seq });
  };
  return { conn, sockets, socket, delivered, resyncs, pages, fetchEvents, handshake };
}

/** Lets the catch-up's promises settle (the ping interval rules out running every timer). */
const settle = () => vi.advanceTimersByTimeAsync(1);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeConnection', () => {
  it('passes the notifications hint on (#93)', () => {
    const onNotifications = vi.fn();
    const t = setup({ onNotifications });
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(5);
    t.socket().receive({ type: 'notifications' });
    expect(onNotifications).toHaveBeenCalledTimes(1);
  });

  it('opens one socket for every subscription and subscribes on ready', () => {
    const t = setup();
    expect(t.conn.status).toBe('idle');
    const off1 = t.conn.subscribe({ tableId: TABLE });
    const off2 = t.conn.subscribe({ tableId: TABLE });
    expect(t.sockets).toHaveLength(1);
    expect(t.conn.status).toBe('connecting');
    t.handshake(5);
    expect(t.conn.status).toBe('live');
    // Ref-counted: one subscribe for the two components.
    expect(t.socket().sent).toEqual([{ type: 'subscribe', target: { tableId: TABLE } }]);
    off1();
    expect(t.socket().sent).toHaveLength(1);
    off2();
    expect(t.socket().sent.at(-1)).toEqual({ type: 'unsubscribe', target: { tableId: TABLE } });
    // The idle socket closes after a while.
    vi.advanceTimersByTime(IDLE_CLOSE_MS);
    expect(t.socket().closed).toBe(1000);
    expect(t.conn.status).toBe('idle');
  });

  it('delivers socket events in order, each once', () => {
    const t = setup();
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(5);
    for (const seq of [4, 5, 6, 9, 9, 7, 12])
      t.socket().receive({ type: 'event', event: event(seq) });
    // 4 and 5 are before the subscription; the repeated 9 and the late 7 are dropped.
    expect(t.delivered).toEqual([6, 9, 12]);
  });

  it('tells change listeners which tables changed, and everything after a resync (#153)', async () => {
    const t = setup({ fetchEvents: async () => Promise.reject(new Error('503')) });
    const changes: (readonly string[] | null)[] = [];
    const off = t.conn.onChanges((tables) => changes.push(tables));
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(5);
    t.socket().receive({ type: 'event', event: event(6) });
    t.socket().receive({ type: 'event', event: event(7, OTHER_TABLE) });
    t.socket().receive({ type: 'event', event: event(7, OTHER_TABLE) });
    expect(changes).toEqual([[TABLE], [OTHER_TABLE]]);
    t.socket().drop();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    t.handshake(12);
    await settle();
    expect(changes.at(-1)).toBeNull();
    off();
    t.socket().receive({ type: 'event', event: event(13) });
    expect(changes).toHaveLength(3);
  });

  it('reconnects with exponential backoff and replays the missed events from the catch-up', async () => {
    const t = setup();
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(10);
    t.socket().receive({ type: 'event', event: event(11) });

    // The server restarts: the socket drops and the first retries fail.
    t.socket().drop(1012);
    expect(t.conn.status).toBe('reconnecting');
    vi.advanceTimersByTime(BACKOFF_BASE_MS - 1);
    expect(t.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.sockets).toHaveLength(2);
    t.socket().drop();
    vi.advanceTimersByTime(BACKOFF_BASE_MS * 2 - 1);
    expect(t.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(t.sockets).toHaveLength(3);

    // Meanwhile 12–15 were written. The catch-up has them in two pages.
    t.pages.set(11, { events: [event(12), event(13)], next: 13, hasMore: true });
    t.pages.set(13, { events: [event(14), event(15)], next: 15, hasMore: false });
    t.handshake(15);
    // An event on the new socket during the catch-up waits for it.
    t.socket().receive({ type: 'event', event: event(16) });
    await settle();
    expect(t.fetchEvents.mock.calls.map((c) => c[1])).toEqual([11, 13]);
    expect(t.delivered).toEqual([11, 12, 13, 14, 15, 16]);
    expect(t.resyncs).toEqual([]);
    expect(t.conn.status).toBe('live');
    // Backoff starts over after a success.
    t.socket().drop();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(t.sockets).toHaveLength(4);
  });

  it('caps the backoff and jitters it', () => {
    const t = setup({ random: () => 0 });
    t.conn.subscribe({ tableId: TABLE });
    for (let i = 0; i < 12; i++) {
      t.socket().drop();
      vi.runOnlyPendingTimers();
    }
    const before = t.sockets.length;
    t.socket().drop();
    // 30 s at most, times 50 % with random() = 0.
    vi.advanceTimersByTime(15_000 - 1);
    expect(t.sockets).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(t.sockets).toHaveLength(before + 1);
  });

  it('resyncs when the missed events are past retention (410)', async () => {
    const t = setup();
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(10);
    t.socket().drop();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    t.pages.set(10, 'expired');
    t.handshake(50);
    t.socket().receive({ type: 'event', event: event(51) });
    await settle();
    expect(t.resyncs).toEqual([BASE]);
    // After the resync the stream goes on from the new socket.
    expect(t.delivered).toEqual([51]);
    t.socket().receive({ type: 'event', event: event(52) });
    expect(t.delivered).toEqual([51, 52]);
  });

  it('resyncs when the catch-up fails', async () => {
    const t = setup({ fetchEvents: async () => Promise.reject(new Error('503')) });
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(10);
    t.socket().drop();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    t.handshake(12);
    await settle();
    expect(t.resyncs).toEqual([BASE]);
  });

  it('resyncs a base whose subscription was never confirmed before the socket dropped', async () => {
    const t = setup();
    t.conn.subscribe({ tableId: TABLE });
    // Ready (live), then the socket drops before `subscribed` arrives: no seq to resume from.
    t.socket().receive({ type: 'ready', userId: '0190a000-0000-7000-8000-0000000000ff' });
    expect(t.conn.status).toBe('live');
    t.socket().drop(1012);
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    // A retry that never comes up doesn't lose that either.
    t.socket().drop();
    vi.advanceTimersByTime(BACKOFF_BASE_MS * 2);
    t.handshake(12);
    await settle();
    expect(t.fetchEvents).not.toHaveBeenCalled();
    expect(t.resyncs).toEqual([BASE]);
    // From there the stream goes on from the new socket, and a later drop catches up as usual.
    t.socket().receive({ type: 'event', event: event(13) });
    expect(t.delivered).toEqual([13]);
    t.socket().drop();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    t.handshake(13);
    await settle();
    expect(t.fetchEvents.mock.calls.map((c) => c[1])).toEqual([13]);
    expect(t.resyncs).toEqual([BASE]);
  });

  it('does not resync a first subscription, nor a target left before the drop', async () => {
    const t = setup();
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(5);
    await settle();
    expect(t.resyncs).toEqual([]);
    // Wanted, unconfirmed and left again before the drop: nothing is shown from it.
    const off = t.conn.subscribe({ tableId: OTHER_TABLE });
    off();
    t.socket().drop();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    t.handshake(5);
    t.conn.subscribe({ tableId: OTHER_TABLE });
    t.socket().receive({
      type: 'subscribed',
      target: { tableId: OTHER_TABLE },
      baseId: OTHER_BASE,
      tableId: OTHER_TABLE,
      seq: 5,
    });
    await settle();
    expect(t.resyncs).toEqual([]);
  });

  it('catches up once per base, whatever the number of subscriptions in it', async () => {
    const t = setup();
    t.conn.subscribe({ tableId: TABLE });
    t.conn.subscribe({ tableId: OTHER_TABLE });
    t.handshake(10);
    t.socket().receive({
      type: 'subscribed',
      target: { tableId: OTHER_TABLE },
      baseId: BASE,
      tableId: OTHER_TABLE,
      seq: 10,
    });
    t.socket().drop();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    t.pages.set(10, { events: [event(11), event(12, OTHER_TABLE)], next: 12, hasMore: false });
    t.handshake(12);
    t.socket().receive({
      type: 'subscribed',
      target: { tableId: OTHER_TABLE },
      baseId: BASE,
      tableId: OTHER_TABLE,
      seq: 12,
    });
    await settle();
    expect(t.fetchEvents).toHaveBeenCalledTimes(1);
    expect(t.delivered).toEqual([11, 12]);
  });

  it('pings, and drops a socket that went silent', () => {
    const t = setup();
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(1);
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(t.socket().sent.at(-1)).toEqual({ type: 'ping' });
    t.socket().receive({ type: 'pong' });
    // Still heard from recently at the next ping; silent for too long at the one after.
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(t.socket().closed).toBeUndefined();
    vi.advanceTimersByTime(PING_EVERY_MS);
    expect(DEAD_AFTER_MS).toBeLessThan(2 * PING_EVERY_MS);
    // No answer since the pong: given up on, and a new socket follows.
    expect(t.socket().closed).toBe(4000);
    expect(t.conn.status).toBe('reconnecting');
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(t.sockets).toHaveLength(2);
  });

  it('waits for the browser to be online', () => {
    let online = true;
    const t = setup({ isOnline: () => online });
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(1);
    online = false;
    t.conn.offline();
    t.socket().drop(1000);
    expect(t.conn.status).toBe('offline');
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
    online = true;
    t.conn.online();
    expect(t.sockets).toHaveLength(2);
    expect(t.conn.status).toBe('reconnecting');
  });

  it('reports a revoked or refused target, and the end of the session', () => {
    const onRevoked = vi.fn();
    const onSessionEnded = vi.fn();
    const t = setup({ onRevoked, onSessionEnded });
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(1);
    t.socket().receive({ type: 'revoked', target: { tableId: TABLE } });
    t.socket().receive({
      type: 'error',
      code: 'NOT_FOUND',
      message: 'No such table or view.',
      target: { tableId: TABLE },
    });
    expect(onRevoked).toHaveBeenCalledTimes(2);
    t.socket().drop(4401);
    expect(onSessionEnded).toHaveBeenCalledOnce();
  });

  it('ignores frames it cannot parse', () => {
    const t = setup();
    t.conn.subscribe({ tableId: TABLE });
    t.handshake(1);
    t.socket().onmessage?.(new MessageEvent('message', { data: 'not json' }));
    t.socket().onmessage?.(new MessageEvent('message', { data: '{"type":"event"}' }));
    expect(t.delivered).toEqual([]);
    expect(t.conn.status).toBe('live');
  });
});

describe('presence (#89)', () => {
  const VIEW = '0190a000-0000-7000-8000-0000000000a1';
  const REC = '0190a000-0000-7000-8000-0000000000a2';
  const FIELD = '0190a000-0000-7000-8000-0000000000a3';
  const state = (recordId: string | null, editing = false) => ({
    recordId,
    fieldId: recordId ? FIELD : null,
    editing,
    expandedRecordId: null,
  });
  const peer = (n: number, recordId: string | null = null) => ({
    connectionId: `0190a000-0000-7000-8000-00000000010${n}`,
    userId: `0190a000-0000-7000-8000-00000000020${n}`,
    name: `Person ${n}`,
    initials: `P${n}`,
    color: 'blue' as const,
    state: state(recordId),
  });
  const viewHandshake = (t: ReturnType<typeof setup>) => {
    t.socket().receive({ type: 'ready', userId: '0190a000-0000-7000-8000-0000000000ff' });
    t.socket().receive({
      type: 'subscribed',
      target: { viewId: VIEW },
      baseId: BASE,
      tableId: TABLE,
      seq: 1,
    });
  };
  const presenceSent = (t: ReturnType<typeof setup>) =>
    t.sockets.flatMap((s) => s.sent).filter((m) => (m as { type: string }).type === 'presence');

  it('sends presence once the view is subscribed, throttled with the latest state winning', () => {
    const t = setup();
    t.conn.subscribe({ viewId: VIEW });
    t.conn.setPresence(VIEW, state(REC));
    expect(presenceSent(t)).toEqual([]);
    viewHandshake(t);
    expect(presenceSent(t)).toEqual([{ type: 'presence', viewId: VIEW, state: state(REC) }]);
    // Three quick changes: one more message, the last state.
    t.conn.setPresence(VIEW, state(REC, true));
    t.conn.setPresence(VIEW, state(null));
    t.conn.setPresence(VIEW, state(REC, true));
    expect(presenceSent(t)).toHaveLength(1);
    vi.advanceTimersByTime(PRESENCE_EVERY_MS);
    expect(presenceSent(t)).toHaveLength(2);
    expect(presenceSent(t).at(-1)).toEqual({
      type: 'presence',
      viewId: VIEW,
      state: state(REC, true),
    });
    // The same state again sends nothing.
    t.conn.setPresence(VIEW, state(REC, true));
    vi.advanceTimersByTime(PRESENCE_EVERY_MS * 2);
    expect(presenceSent(t)).toHaveLength(2);
  });

  it('keeps the peers of a view, updates them in place and drops them on leave or reconnect', () => {
    const t = setup();
    t.conn.subscribe({ viewId: VIEW });
    viewHandshake(t);
    t.conn.setPresence(VIEW, state(REC));
    const changes = vi.fn();
    t.conn.onPeers(changes);
    t.socket().receive({ type: 'presence', viewId: VIEW, peer: peer(1) });
    t.socket().receive({ type: 'presence', viewId: VIEW, peer: peer(2) });
    t.socket().receive({ type: 'presence', viewId: VIEW, peer: peer(1, REC) });
    expect(t.conn.peers(VIEW).map((p) => [p.initials, p.state.recordId])).toEqual([
      ['P1', REC],
      ['P2', null],
    ]);
    const stable = t.conn.peers(VIEW);
    expect(t.conn.peers(VIEW)).toBe(stable);
    t.socket().receive({ type: 'presenceLeft', viewId: VIEW, connectionId: peer(2).connectionId });
    expect(t.conn.peers(VIEW).map((p) => p.initials)).toEqual(['P1']);
    expect(changes).toHaveBeenCalledTimes(4);
    // Presence for a view this tab doesn't want is ignored.
    t.socket().receive({
      type: 'presence',
      viewId: '0190a000-0000-7000-8000-0000000000ee',
      peer: peer(3),
    });
    expect(t.conn.peers('0190a000-0000-7000-8000-0000000000ee')).toEqual([]);

    // A new socket starts empty and gets this tab's state again.
    t.socket().drop(1012);
    expect(t.conn.peers(VIEW)).toEqual([]);
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    viewHandshake(t);
    vi.advanceTimersByTime(PRESENCE_EVERY_MS);
    expect(t.socket().sent.filter((m) => (m as { type: string }).type === 'presence')).toEqual([
      { type: 'presence', viewId: VIEW, state: state(REC) },
    ]);
  });

  it('forgets the peers of a view on revoke and when the view is left', () => {
    const t = setup();
    const off = t.conn.subscribe({ viewId: VIEW });
    viewHandshake(t);
    t.socket().receive({ type: 'presence', viewId: VIEW, peer: peer(1) });
    t.socket().receive({ type: 'revoked', target: { viewId: VIEW } });
    expect(t.conn.peers(VIEW)).toEqual([]);
    t.socket().receive({ type: 'presence', viewId: VIEW, peer: peer(1) });
    off();
    expect(t.conn.peers(VIEW)).toEqual([]);
  });
});
