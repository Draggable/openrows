import type {
  EventList,
  RealtimeEvent,
  RealtimeServerMessage,
  RealtimeTarget,
  UserRole,
} from '@openrows/shared';
import { mentionToken, USER_ROLES } from '@openrows/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { inScope } from '../../src/authz/scope.js';
import { emit, pruneOutbox } from '../../src/data/outbox.js';
import { outbox, type Transaction, type tables, views } from '../../src/db/index.js';
import { startRealtime } from '../../src/realtime/index.js';
import { startServer } from '../../src/server.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createRecordsIn,
  createSession,
  createTableWithFields,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';
import { relayAll } from '../helpers/outbox.js';

const t = useTestDb();

type User = Awaited<ReturnType<typeof createUser>>;
type Table = typeof tables.$inferSelect;

let app: ReturnType<typeof testApp>;
let realtime: Awaited<ReturnType<typeof startRealtime>>;
let server: Awaited<ReturnType<typeof startServer>>;
let wsUrl: string;
const sockets: WebSocket[] = [];

/** A small per-socket subscription cap and rate, so the limit tests stay quick. */
const LIMITS = { maxSubscriptions: 3, messagesPerSecond: 50, maxConnectionsPerUser: 4 };

beforeAll(async () => {
  app = testApp({ db: t.appDb, config: { databaseUrl: t.appUrl } });
  realtime = await startRealtime({
    config: { appUrl: app.config.appUrl, databaseUrl: t.appUrl, eventBus: 'postgres' },
    db: t.appDb,
    store: app.store,
    logger: app.logger,
    limits: LIMITS,
  });
  server = await startServer(app.app, 0, {
    onUpgrade: (req, socket, head) => realtime.gateway.handleUpgrade(req, socket, head),
  });
  wsUrl = `ws://127.0.0.1:${server.port}/ws`;
});

afterAll(async () => {
  for (const s of sockets) s.terminate();
  await realtime?.close();
  await server?.close();
});

interface Conn {
  ws: WebSocket;
  messages: RealtimeServerMessage[];
  /** Resolves with the first message (from the start) matching `pred`. */
  waitFor<M extends RealtimeServerMessage>(
    pred: (m: RealtimeServerMessage) => m is M,
    timeoutMs?: number
  ): Promise<M>;
  events(): RealtimeEvent[];
  closed: Promise<{ code: number; reason: string }>;
}

function connect(token: string | undefined, origin: string | undefined = app.config.appUrl) {
  const headers: Record<string, string> = {};
  if (origin) headers['origin'] = origin;
  if (token) headers['cookie'] = `${SESSION_COOKIE}=${token}`;
  const ws = new WebSocket(wsUrl, { headers });
  sockets.push(ws);
  return ws;
}

/** The HTTP status of a refused upgrade. */
function refusal(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => reject(new Error('upgrade was accepted')));
    ws.on('error', () => {});
  });
}

async function open(user: User): Promise<Conn> {
  const token = await createSession(t.db, user);
  const ws = connect(token);
  const messages: RealtimeServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (data) => {
    messages.push(JSON.parse(String(data)) as RealtimeServerMessage);
    for (const w of [...waiters]) w();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
  );
  const conn: Conn = {
    ws,
    messages,
    closed,
    events: () => messages.flatMap((m) => (m.type === 'event' ? [m.event] : [])),
    waitFor: (pred, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = messages.find(pred);
          if (!found) return false;
          waiters.splice(waiters.indexOf(check), 1);
          clearTimeout(timer);
          resolve(found as never);
          return true;
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`timed out; got ${JSON.stringify(messages)}`));
        }, timeoutMs);
        waiters.push(check);
        check();
      }),
  };
  await conn.waitFor(
    (m): m is Extract<RealtimeServerMessage, { type: 'ready' }> => m.type === 'ready'
  );
  return conn;
}

const is =
  <T extends RealtimeServerMessage['type']>(type: T, extra: (m: never) => boolean = () => true) =>
  (m: RealtimeServerMessage): m is Extract<RealtimeServerMessage, { type: T }> =>
    m.type === type && extra(m as never);

async function subscribe(conn: Conn, target: RealtimeTarget) {
  const key = JSON.stringify(target);
  const before = conn.messages.length;
  conn.ws.send(JSON.stringify({ type: 'subscribe', target }));
  return conn.waitFor(
    (m): m is Extract<RealtimeServerMessage, { type: 'subscribed' | 'error' }> =>
      conn.messages.indexOf(m) >= before &&
      (m.type === 'subscribed' || m.type === 'error') &&
      JSON.stringify(m.target) === key
  );
}

/** An HTTP request to the app as `user`. */
async function request(user: User, path: string, init: RequestInit = {}) {
  const token = await createSession(t.db, user);
  const headers = new Headers(init.headers);
  headers.set('cookie', `${SESSION_COOKIE}=${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  return app.app.request(path, { ...init, headers });
}

async function patchNotes(user: User, table: Table, recordId: string, notesId: string, v: string) {
  const res = await request(user, `/api/tables/${table.id}/records/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { [notesId]: v }, clientOpId: `op-${v}` }),
  });
  expect(res.status).toBe(200);
}

/** A workspace with a member per role, a base and a real table with one live record. */
async function world() {
  const { workspace, owner } = await createWorkspace(t.db);
  const members = { owner } as Record<UserRole, User>;
  for (const role of USER_ROLES) {
    if (role !== 'owner') members[role] = await addMember(t.db, workspace.id, role);
  }
  const base = await createBase(t.db, workspace.id);
  const { table, field } = await createTableWithFields(t.appDb, owner, base);
  const { record } = await createRecordsIn(t.appDb, owner, table);
  return { workspace, base, table, notes: field, record, members };
}

/** Quiet period: lets in-flight notifications land before asserting that nothing arrived. */
async function settle(conns: Conn[], sentinel: () => Promise<void>) {
  // A write the recipients *do* see, after everything else: once it arrives, earlier ones have.
  await sentinel();
  await Promise.all(
    conns.map((c) =>
      c.waitFor(is('event', (m: { event: RealtimeEvent }) => m.event.clientOpId === 'op-sentinel'))
    )
  );
}

describe('realtime gateway (#87)', () => {
  it('refuses cross-origin, origin-less and unauthenticated upgrades, and other paths', async () => {
    const user = await createUser(t.db);
    const token = await createSession(t.db, user);
    expect(await refusal(connect(token, 'https://evil.example'))).toBe(403);
    expect(await refusal(connect(token, ''))).toBe(403);
    expect(await refusal(connect(undefined))).toBe(401);
    expect(await refusal(connect('not-a-session'))).toBe(401);
    // No tokens in query strings: a session there is ignored.
    const queryToken = new WebSocket(`${wsUrl}?session=${token}`, {
      headers: { origin: app.config.appUrl },
    });
    sockets.push(queryToken);
    expect(await refusal(queryToken)).toBe(401);
    const elsewhere = new WebSocket(wsUrl.replace('/ws', '/api/ws'), {
      headers: { origin: app.config.appUrl, cookie: `${SESSION_COOKIE}=${token}` },
    });
    sockets.push(elsewhere);
    expect(await refusal(elsewhere)).toBe(404);
  });

  it('delivers a cell change to two members in order with seq, and nothing to another tenant', async () => {
    const w = await world();
    const other = await world();
    const a = await open(w.members.editor);
    const b = await open(w.members.read_only);
    const outsider = await open(other.members.owner);
    const subA = await subscribe(a, { tableId: w.table.id });
    const subB = await subscribe(b, { tableId: w.table.id });
    expect(subA).toMatchObject({ type: 'subscribed', baseId: w.base.id, tableId: w.table.id });
    expect(subB.type).toBe('subscribed');
    expect(await subscribe(outsider, { tableId: other.table.id })).toMatchObject({
      type: 'subscribed',
    });

    await patchNotes(w.members.editor, w.table, w.record.id, w.notes.id, 'one');
    await patchNotes(w.members.editor, w.table, w.record.id, w.notes.id, 'two');
    for (const conn of [a, b]) {
      await conn.waitFor(
        is('event', (m: { event: RealtimeEvent }) => m.event.clientOpId === 'op-two')
      );
      const updates = conn.events().filter((e) => e.kind === 'record.updated');
      expect(updates.map((e) => e.clientOpId)).toEqual(['op-one', 'op-two']);
      expect(updates[0]).toMatchObject({
        baseId: w.base.id,
        tableId: w.table.id,
        actorId: w.members.editor.id,
        payload: { recordId: w.record.id, cells: { [w.notes.id]: 'one' } },
      });
      const [first, second] = updates;
      expect(first && second && first.seq < second.seq).toBe(true);
      expect(first && 'seq' in subA && first.seq > subA.seq).toBe(true);
    }

    await settle([outsider], async () => {
      await patchNotes(
        other.members.owner,
        other.table,
        other.record.id,
        other.notes.id,
        'sentinel'
      );
    });
    expect(outsider.events().map((e) => e.clientOpId)).toEqual(['op-sentinel']);
    expect(outsider.events().every((e) => e.baseId === other.base.id)).toBe(true);
  });

  it('authorizes subscribe for every role, and refuses other tenants without revealing ids', async () => {
    const w = await world();
    const other = await world();
    const [view] = await t.db
      .select()
      .from(views)
      .where(sql`${views.tableId} = ${w.table.id}`)
      .limit(1);
    if (!view) throw new Error('no view');
    for (const role of USER_ROLES) {
      const conn = await open(w.members[role]);
      expect(await subscribe(conn, { tableId: w.table.id }), role).toMatchObject({
        type: 'subscribed',
      });
      expect(await subscribe(conn, { viewId: view.id }), role).toMatchObject({
        type: 'subscribed',
        tableId: w.table.id,
      });
      conn.ws.close();
    }
    // Another tenant, a nonexistent id and a malformed one all look the same.
    const outsider = await open(other.members.owner);
    const foreign = await subscribe(outsider, { tableId: w.table.id });
    const missing = await subscribe(outsider, { tableId: '0190a000-0000-7000-8000-000000000000' });
    const foreignView = await subscribe(outsider, { viewId: view.id });
    for (const refused of [foreign, missing, foreignView]) {
      expect(refused).toMatchObject({
        type: 'error',
        code: 'NOT_FOUND',
        message: 'No such table or view.',
      });
    }
    outsider.ws.send(JSON.stringify({ type: 'subscribe', target: { tableId: 'nope' } }));
    await outsider.waitFor(is('error', (m: { code: string }) => m.code === 'BAD_MESSAGE'));
    // Writes in the foreign table never reach the refused socket.
    await settle([outsider], async () => {
      await subscribe(outsider, { tableId: other.table.id });
      await patchNotes(w.members.owner, w.table, w.record.id, w.notes.id, 'secret');
      await patchNotes(
        other.members.owner,
        other.table,
        other.record.id,
        other.notes.id,
        'sentinel'
      );
    });
    expect(outsider.events().map((e) => e.clientOpId)).toEqual(['op-sentinel']);
  });

  it("sends a personal view's events to its owner only", async () => {
    const w = await world();
    const owner = await open(w.members.owner);
    const editor = await open(w.members.editor);
    await subscribe(owner, { tableId: w.table.id });
    await subscribe(editor, { tableId: w.table.id });
    const res = await request(w.members.editor, `/api/tables/${w.table.id}/views`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Mine', type: 'grid', personal: true }),
    });
    expect(res.status).toBe(201);
    const created = await editor.waitFor(
      is('event', (m: { event: RealtimeEvent }) => m.event.kind === 'view.created')
    );
    expect(created.event.payload).not.toHaveProperty('personalTo');
    await settle([owner], async () => {
      await patchNotes(w.members.owner, w.table, w.record.id, w.notes.id, 'sentinel');
    });
    expect(owner.events().some((e) => e.kind.startsWith('view.'))).toBe(false);
  });

  it('emits nothing for a rolled-back transaction', async () => {
    const w = await world();
    const conn = await open(w.members.owner);
    await subscribe(conn, { tableId: w.table.id });
    await expect(
      inScope(t.appDb, { userId: w.members.owner.id, workspaceId: w.workspace.id }, async (tx) => {
        await emit(tx, {
          workspaceId: w.workspace.id,
          baseId: w.base.id,
          tableId: w.table.id,
          kind: 'record.updated',
          payload: { recordId: w.record.id },
          actorId: w.members.owner.id,
          clientOpId: 'rolled-back',
        });
        throw new Error('roll back');
      })
    ).rejects.toThrow('roll back');
    await settle([conn], async () => {
      await patchNotes(w.members.owner, w.table, w.record.id, w.notes.id, 'sentinel');
    });
    expect(conn.events().map((e) => e.clientOpId)).toEqual(['op-sentinel']);
  });

  it('holds back a later commit until an earlier id commits, so nothing is skipped', async () => {
    const w = await world();
    const conn = await open(w.members.owner);
    await subscribe(conn, { tableId: w.table.id });
    const event = (clientOpId: string) => ({
      workspaceId: w.workspace.id,
      baseId: w.base.id,
      tableId: w.table.id,
      kind: 'record.updated' as const,
      payload: { recordId: w.record.id },
      actorId: w.members.owner.id,
      clientOpId,
    });
    const scope = { userId: w.members.owner.id, workspaceId: w.workspace.id };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let emitted!: () => void;
    const first = new Promise<void>((r) => {
      emitted = r;
    });
    // Takes the lower id, then waits before committing.
    const slow = inScope(t.appDb, scope, async (tx: Transaction) => {
      await emit(tx, event('first'));
      emitted();
      await gate;
    });
    await first;
    await inScope(t.appDb, scope, (tx) => emit(tx, event('second')));
    await new Promise((r) => setTimeout(r, 150));
    expect(conn.events()).toEqual([]);
    release();
    await slow;
    await conn.waitFor(
      is('event', (m: { event: RealtimeEvent }) => m.event.clientOpId === 'second')
    );
    expect(conn.events().map((e) => e.clientOpId)).toEqual(['first', 'second']);
  });

  it('catch-up returns exactly the missed events, paged, and 410 past retention', async () => {
    const w = await world();
    const conn = await open(w.members.editor);
    const sub = await subscribe(conn, { tableId: w.table.id });
    if (sub.type !== 'subscribed') throw new Error('not subscribed');
    conn.ws.close();
    await conn.closed;
    for (const v of ['a', 'b', 'c']) {
      await patchNotes(w.members.owner, w.table, w.record.id, w.notes.id, v);
    }
    const page = async (since: number, limit?: number) => {
      const q = `since=${since}${limit ? `&limit=${limit}` : ''}`;
      const res = await request(w.members.read_only, `/api/bases/${w.base.id}/events?${q}`);
      expect(res.status).toBe(200);
      return (await res.json()) as EventList;
    };
    const all = await page(sub.seq);
    expect(all.events.map((e) => e.clientOpId)).toEqual(['op-a', 'op-b', 'op-c']);
    expect(all.hasMore).toBe(false);
    const first = await page(sub.seq, 2);
    expect(first.events.map((e) => e.clientOpId)).toEqual(['op-a', 'op-b']);
    expect(first.hasMore).toBe(true);
    const rest = await page(first.next, 2);
    expect(rest.events.map((e) => e.clientOpId)).toEqual(['op-c']);
    expect(rest.hasMore).toBe(false);
    expect(rest.next).toBe(all.events.at(-1)?.seq);

    // Another tenant: 404; bad `since`: 422.
    const other = await world();
    const foreign = await request(other.members.owner, `/api/bases/${w.base.id}/events?since=0`);
    expect(foreign.status).toBe(404);
    const bad = await request(w.members.owner, `/api/bases/${w.base.id}/events?since=-1`);
    expect(bad.status).toBe(422);

    // Past retention: everything older than 7 days is pruned, and a `since` before it is 410.
    await t.db.execute(sql`UPDATE ${outbox} SET created_at = now() - interval '8 days'`);
    // Only events the relay has read are pruned.
    await relayAll(t.appDb);
    expect(await pruneOutbox(t.appDb, 7)).toBeGreaterThan(0);
    const expired = await request(
      w.members.owner,
      `/api/bases/${w.base.id}/events?since=${sub.seq}`
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ code: 'EVENTS_EXPIRED' });
    // A subscriber after the prune starts at the floor, which catch-up accepts.
    const late = await open(w.members.owner);
    const lateSub = await subscribe(late, { tableId: w.table.id });
    if (lateSub.type !== 'subscribed') throw new Error('not subscribed');
    expect((await page(lateSub.seq)).events).toEqual([]);
  });

  it("revokes a removed member's live subscription before later events", async () => {
    const w = await world();
    const editor = await open(w.members.editor);
    const owner = await open(w.members.owner);
    await subscribe(editor, { tableId: w.table.id });
    await subscribe(owner, { tableId: w.table.id });
    const res = await request(
      w.members.owner,
      `/api/workspaces/${w.workspace.id}/members/${w.members.editor.id}`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(204);
    await patchNotes(w.members.owner, w.table, w.record.id, w.notes.id, 'after');
    await editor.waitFor(is('revoked'));
    await owner.waitFor(
      is('event', (m: { event: RealtimeEvent }) => m.event.clientOpId === 'op-after')
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(editor.events().some((e) => e.clientOpId === 'op-after')).toBe(false);
    // Resubscribing is refused like any other unknown table.
    expect(await subscribe(editor, { tableId: w.table.id })).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('revokes subscriptions to a deleted table and closes sockets whose session ended', async () => {
    const w = await world();
    const conn = await open(w.members.creator);
    await subscribe(conn, { tableId: w.table.id });
    const res = await request(w.members.owner, `/api/tables/${w.table.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    await conn.waitFor(
      is('event', (m: { event: RealtimeEvent }) => m.event.kind === 'table.deleted')
    );
    await conn.waitFor(is('revoked'));

    await t.db.execute(sql`DELETE FROM sessions WHERE user_id = ${w.members.creator.id}`);
    await realtime.gateway.runChecks();
    expect((await conn.closed).code).toBe(4401);
  });

  it('enforces the message size, subscription, rate and connection limits', async () => {
    const w = await world();
    const conn = await open(w.members.owner);
    const extra: Table[] = [];
    for (const n of [1, 2, 3]) {
      extra.push((await createTableWithFields(t.appDb, w.members.owner, w.base, `T${n}`)).table);
    }
    for (const table of [w.table, ...extra.slice(0, 2)]) {
      expect(await subscribe(conn, { tableId: table.id })).toMatchObject({ type: 'subscribed' });
    }
    const fourth = extra[2];
    if (!fourth) throw new Error('no table');
    expect(await subscribe(conn, { tableId: fourth.id })).toMatchObject({
      type: 'error',
      code: 'TOO_MANY_SUBSCRIPTIONS',
    });
    conn.ws.send(JSON.stringify({ type: 'unsubscribe', target: { tableId: w.table.id } }));
    await conn.waitFor(is('unsubscribed'));
    expect(await subscribe(conn, { tableId: fourth.id })).toMatchObject({ type: 'subscribed' });

    // Over the burst: refused, then closed for too many refusals.
    const flood = await open(w.members.editor);
    for (let i = 0; i < 200; i++) flood.ws.send(JSON.stringify({ type: 'ping' }));
    await flood.waitFor(is('error', (m: { code: string }) => m.code === 'RATE_LIMITED'));
    expect((await flood.closed).code).toBe(1008);

    // A frame over 16 kB closes the socket (1009).
    const big = await open(w.members.editor);
    big.ws.send('x'.repeat(17 * 1024));
    expect((await big.closed).code).toBe(1009);

    // Per-user connection cap.
    const user = w.members.commenter;
    const held = await Promise.all([1, 2, 3, 4].map(() => open(user)));
    const token = await createSession(t.db, user);
    expect(await refusal(connect(token))).toBe(429);
    for (const c of held) c.ws.close();
  });
});

describe('notifications hint (#93)', () => {
  it('tells only the recipient, on every socket and without a subscription, and again on read', async () => {
    const w = await world();
    const recipient = await open(w.members.editor);
    const second = await open(w.members.editor);
    const bystander = await open(w.members.commenter);
    const res = await request(
      w.members.owner,
      `/api/tables/${w.table.id}/records/${w.record.id}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body: `Hi ${mentionToken(w.members.editor.id, 'Ed')}` }),
      }
    );
    expect(res.status).toBe(201);
    for (const conn of [recipient, second]) await conn.waitFor(is('notifications'));
    const before = recipient.messages.filter((m) => m.type === 'notifications').length;
    const read = await request(w.members.editor, '/api/notifications/read', { method: 'POST' });
    expect(read.status).toBe(200);
    await recipient.waitFor(
      (m): m is RealtimeServerMessage =>
        recipient.messages.filter((x) => x.type === 'notifications').length > before
    );
    // The bystander's socket got nothing about it (a ping round trip flushes anything in flight).
    bystander.ws.send(JSON.stringify({ type: 'ping' }));
    await bystander.waitFor(is('pong'));
    expect(bystander.messages.some((m) => m.type === 'notifications')).toBe(false);
    for (const conn of [recipient, second, bystander]) conn.ws.close();
  });
});

describe('presence (#89)', () => {
  type Presence = Extract<RealtimeServerMessage, { type: 'presence' }>;
  type Left = Extract<RealtimeServerMessage, { type: 'presenceLeft' }>;
  const STATE = {
    recordId: '0190a000-0000-7000-8000-00000000000a',
    fieldId: '0190a000-0000-7000-8000-00000000000b',
    editing: true,
    expandedRecordId: null,
  };

  async function viewOf(table: Table) {
    const [view] = await t.db
      .select()
      .from(views)
      .where(sql`${views.tableId} = ${table.id}`)
      .limit(1);
    if (!view) throw new Error('no view');
    return view;
  }

  const presenceOf = (conn: Conn, userId: string) =>
    conn.messages.filter((m): m is Presence => m.type === 'presence' && m.peer.userId === userId);
  const isPresence = (userId: string, pred: (m: Presence) => boolean = () => true) =>
    is('presence', (m: Presence) => m.peer.userId === userId && pred(m));

  /** Everything the server queued for `conn` before now has arrived (pong comes after it). */
  async function drained(conn: Conn) {
    const before = conn.messages.length;
    conn.ws.send(JSON.stringify({ type: 'ping' }));
    await conn.waitFor(
      (m): m is Extract<RealtimeServerMessage, { type: 'pong' }> =>
        m.type === 'pong' && conn.messages.indexOf(m) >= before
    );
  }

  const send = (conn: Conn, viewId: string, state: object) =>
    conn.ws.send(JSON.stringify({ type: 'presence', viewId, state }));

  it('shares who is on a view and their selected cell, without emails, and drops them on leave', async () => {
    const w = await world();
    const view = await viewOf(w.table);
    const a = await open(w.members.owner);
    const b = await open(w.members.editor);
    await subscribe(a, { viewId: view.id });
    await subscribe(b, { viewId: view.id });
    // B joined after A: A's entry came with the subscription, B's reached A.
    const seen = await b.waitFor(isPresence(w.members.owner.id));
    expect(seen.peer).toMatchObject({
      userId: w.members.owner.id,
      state: { recordId: null, fieldId: null, editing: false, expandedRecordId: null },
    });
    await a.waitFor(isPresence(w.members.editor.id));

    send(a, view.id, STATE);
    const moved = await b.waitFor(isPresence(w.members.owner.id, (m) => m.peer.state.editing));
    expect(moved).toMatchObject({ viewId: view.id, peer: { state: STATE } });
    expect(moved.peer.name.length).toBeGreaterThan(0);
    expect(moved.peer.initials.length).toBeGreaterThan(0);
    expect(Object.keys(moved.peer).sort()).toEqual(
      ['color', 'connectionId', 'initials', 'name', 'state', 'userId'].sort()
    );
    expect(JSON.stringify(b.messages)).not.toContain('@');

    // A late joiner gets the current state; no one gets their own user's presence.
    const c = await open(w.members.commenter);
    await subscribe(c, { viewId: view.id });
    await c.waitFor(isPresence(w.members.owner.id, (m) => m.peer.state.editing));
    await c.waitFor(isPresence(w.members.editor.id));
    await drained(a);
    expect(presenceOf(a, w.members.owner.id)).toEqual([]);

    // A commenter can't be "editing".
    send(c, view.id, STATE);
    const commenter = await b.waitFor(
      isPresence(w.members.commenter.id, (m) => m.peer.state.recordId !== null)
    );
    expect(commenter.peer.state.editing).toBe(false);

    // Closing the socket leaves at once; so does unsubscribing.
    const leftAt = Date.now();
    a.ws.close();
    const left = await b.waitFor(
      is('presenceLeft', (m: Left) => m.connectionId === moved.peer.connectionId)
    );
    expect(left.viewId).toBe(view.id);
    expect(Date.now() - leftAt).toBeLessThan(5000);
    await c.waitFor(is('presenceLeft', (m: Left) => m.connectionId === moved.peer.connectionId));
    b.ws.send(JSON.stringify({ type: 'unsubscribe', target: { viewId: view.id } }));
    await c.waitFor(is('presenceLeft', (m: Left) => m.connectionId !== moved.peer.connectionId));
  });

  it('never sends presence to a socket without access to the view (matrix)', async () => {
    const w = await world();
    const other = await world();
    const view = await viewOf(w.table);
    const res = await request(w.members.editor, `/api/tables/${w.table.id}/views`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Mine', type: 'grid', personal: true }),
    });
    expect(res.status).toBe(201);
    const personal = (await res.json()) as { id: string };

    const actor = await open(w.members.editor);
    await subscribe(actor, { viewId: view.id });
    await subscribe(actor, { viewId: personal.id });

    // Every role on the view receives it.
    const allowed: Conn[] = [];
    for (const role of USER_ROLES) {
      if (role === 'editor') continue;
      const conn = await open(w.members[role]);
      expect(await subscribe(conn, { viewId: view.id }), role).toMatchObject({
        type: 'subscribed',
      });
      allowed.push(conn);
    }
    // Refused: another tenant (subscribe fails), the owner on the editor's personal view (it
    // doesn't exist for them), a socket on the table only, and one on another tenant's view.
    const outsider = await open(other.members.owner);
    expect(await subscribe(outsider, { viewId: view.id })).toMatchObject({
      type: 'error',
      code: 'NOT_FOUND',
    });
    expect(await subscribe(outsider, { viewId: personal.id })).toMatchObject({
      type: 'error',
      code: 'NOT_FOUND',
    });
    await subscribe(outsider, { viewId: (await viewOf(other.table)).id });
    const tableOnly = await open(w.members.creator);
    await subscribe(tableOnly, { tableId: w.table.id });
    const owner = await open(w.members.owner);
    expect(await subscribe(owner, { viewId: personal.id })).toMatchObject({
      type: 'error',
      code: 'NOT_FOUND',
    });
    // Presence for a view the socket isn't subscribed to is refused and goes nowhere.
    send(outsider, view.id, STATE);
    await outsider.waitFor(is('error', (m: { code: string }) => m.code === 'NOT_SUBSCRIBED'));

    send(actor, view.id, STATE);
    send(actor, personal.id, { ...STATE, expandedRecordId: STATE.recordId });
    for (const conn of allowed) {
      await conn.waitFor(isPresence(w.members.editor.id, (m) => m.peer.state.editing));
    }
    for (const conn of [outsider, tableOnly, owner]) await drained(conn);
    expect(presenceOf(outsider, w.members.editor.id)).toEqual([]);
    expect(presenceOf(tableOnly, w.members.editor.id)).toEqual([]);
    expect(presenceOf(owner, w.members.editor.id).every((m) => m.viewId === view.id)).toBe(true);
    for (const conn of [...allowed, outsider, tableOnly, owner]) {
      const presence = conn.messages.filter((m) => m.type.startsWith('presence'));
      expect(JSON.stringify(presence)).not.toContain(personal.id);
    }

    // A member removed from the workspace stops receiving it.
    const [readOnly] = allowed.slice(-1);
    if (!readOnly) throw new Error('no read-only socket');
    const removed = await request(
      w.members.owner,
      `/api/workspaces/${w.workspace.id}/members/${w.members.read_only.id}`,
      { method: 'DELETE' }
    );
    expect(removed.status).toBe(204);
    await readOnly.waitFor(is('revoked'));
    const before = readOnly.messages.length;
    send(actor, view.id, { ...STATE, editing: false });
    await allowed[0]?.waitFor(isPresence(w.members.editor.id, (m) => !m.peer.state.editing));
    await drained(readOnly);
    expect(readOnly.messages.slice(before).some((m) => m.type === 'presence')).toBe(false);
    // And the others saw them leave.
    await allowed[0]?.waitFor(is('presenceLeft'));
  });

  it('rate-limits presence per socket', async () => {
    const w = await world();
    const view = await viewOf(w.table);
    const a = await open(w.members.owner);
    await subscribe(a, { viewId: view.id });
    for (let i = 0; i < 30; i++) send(a, view.id, { ...STATE, editing: i % 2 === 0 });
    await a.waitFor(is('error', (m: { code: string }) => m.code === 'RATE_LIMITED'));
  });

  it('crosses processes over the bus, and expires the entries of a process that died', async () => {
    const w = await world();
    const view = await viewOf(w.table);
    const startProcess = async (limits: Partial<typeof LIMITS & { presenceTtlMs: number }>) => {
      const rt = await startRealtime({
        config: { appUrl: app.config.appUrl, databaseUrl: t.appUrl, eventBus: 'postgres' },
        db: t.appDb,
        store: app.store,
        logger: app.logger,
        limits,
      });
      const srv = await startServer(app.app, 0, {
        onUpgrade: (req, socket, head) => rt.gateway.handleUpgrade(req, socket, head),
      });
      return { rt, srv, url: `ws://127.0.0.1:${srv.port}/ws` };
    };
    const two = await startProcess({ presenceTtlMs: 100 });
    const three = await startProcess({});
    try {
      const at = async (url: string, user: User) => {
        const saved = wsUrl;
        wsUrl = url;
        try {
          return await open(user);
        } finally {
          wsUrl = saved;
        }
      };
      const a = await open(w.members.owner);
      const b = await at(two.url, w.members.editor);
      const c = await at(three.url, w.members.creator);
      await subscribe(b, { viewId: view.id });
      await subscribe(a, { viewId: view.id });
      await subscribe(c, { viewId: view.id });
      send(a, view.id, STATE);
      await b.waitFor(isPresence(w.members.owner.id, (m) => m.peer.state.editing));
      await b.waitFor(isPresence(w.members.creator.id));
      // Every process keeps the entries it heard of; the refresh re-announces them.
      realtime.gateway.refreshPresence();
      await c.waitFor(isPresence(w.members.owner.id, (m) => m.peer.state.editing));

      // A leave crosses too.
      const owner = presenceOf(b, w.members.owner.id)[0]?.peer.connectionId;
      a.ws.close();
      await b.waitFor(is('presenceLeft', (m: Left) => m.connectionId === owner));

      // Process three dies without a word: two drops its entries after the TTL.
      const creator = presenceOf(b, w.members.creator.id)[0]?.peer.connectionId;
      await three.rt.bus.close();
      await new Promise((r) => setTimeout(r, 150));
      two.rt.gateway.refreshPresence();
      await b.waitFor(is('presenceLeft', (m: Left) => m.connectionId === creator));
    } finally {
      await two.rt.close();
      await three.rt.close();
      await two.srv.close();
      await three.srv.close();
    }
  });
});
