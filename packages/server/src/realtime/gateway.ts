import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type Action,
  EMPTY_PRESENCE,
  PRESENCE_MAX_NAME,
  PRESENCE_MESSAGES_PER_SECOND,
  type PresencePeer,
  type PresenceState,
  REALTIME_MAX_MESSAGE_BYTES,
  REALTIME_MAX_SUBSCRIPTIONS,
  type RealtimeErrorCode,
  type RealtimeServerMessage,
  type RealtimeTarget,
  realtimeClientMessageSchema,
  roleAllows,
  type UserRole,
  userColor,
  userInitials,
} from '@openrows/shared';
import { and, eq } from 'drizzle-orm';
import { parse as parseCookies } from 'hono/utils/cookie';
import { type WebSocket, WebSocketServer } from 'ws';
import { SESSION_COOKIE } from '../auth/session-token.js';
import type { Principal, SessionStore } from '../auth/sessions.js';
import { authorize } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { inScope } from '../authz/scope.js';
import type { OutboxRow } from '../data/outbox.js';
import { type Database, views } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import { visibleTo } from '../views/visibility.js';
import { displayName } from '../workspaces/collaborators.js';
import type { BaseWatch, EventBus, PresenceBusMessage } from './bus.js';
import { allFieldsVisible, type FieldVisibility, projectEvent } from './projection.js';

/** The gateway's limits; the defaults suit production, tests shorten the timers. */
export interface RealtimeLimits {
  maxMessageBytes: number;
  maxSubscriptions: number;
  /** Open sockets per user in this process. */
  maxConnectionsPerUser: number;
  /** Messages per second per socket (token bucket: this rate, twice this burst). */
  messagesPerSecond: number;
  /** Refused messages before the socket is closed (1008). */
  maxRefusals: number;
  /** Ping interval; a socket that didn't answer the previous ping is dropped. */
  heartbeatMs: number;
  /** A socket without subscriptions for this long is closed (4000). */
  idleMs: number;
  /** How often sessions and subscriptions are checked again, besides access-change events. */
  recheckMs: number;
  /** Unsent bytes beyond which a slow socket is closed (1013); it reconnects and catches up. */
  maxBufferedBytes: number;
  /** Presence messages per second per socket (token bucket: this rate, twice this burst). */
  presencePerSecond: number;
  /** People shown on one view; sockets beyond this still get events but no presence entry. */
  maxPeersPerView: number;
  /** How often this process re-announces its sockets' presence to the other processes. */
  presenceRefreshMs: number;
  /** Another process's presence entry not re-announced for this long is dropped (it died). */
  presenceTtlMs: number;
}

export const DEFAULT_LIMITS: RealtimeLimits = {
  maxMessageBytes: REALTIME_MAX_MESSAGE_BYTES,
  maxSubscriptions: REALTIME_MAX_SUBSCRIPTIONS,
  maxConnectionsPerUser: 20,
  messagesPerSecond: 20,
  maxRefusals: 20,
  heartbeatMs: 30_000,
  idleMs: 5 * 60_000,
  recheckMs: 60_000,
  maxBufferedBytes: 4 * 1024 * 1024,
  presencePerSecond: PRESENCE_MESSAGES_PER_SECOND,
  maxPeersPerView: 50,
  presenceRefreshMs: 10_000,
  presenceTtlMs: 30_000,
};

/** Close codes besides the standard ones (1001 going away, 1008 policy, 1009 too big). */
export const CLOSE = {
  SESSION_ENDED: 4401,
  IDLE: 4000,
  TOO_SLOW: 1013,
  POLICY: 1008,
  GOING_AWAY: 1001,
} as const;

interface Subscription {
  key: string;
  target: RealtimeTarget;
  workspaceId: string;
  baseId: string;
  tableId: string;
  role: UserRole;
}

type Access = Omit<Subscription, 'key' | 'target'> | { denied: 'NOT_FOUND' | 'FORBIDDEN' };

interface BaseState {
  /** Resolves once the bus watches the base for this socket. */
  ready: Promise<BaseWatch>;
  watch: BaseWatch | undefined;
}

interface Client {
  /** The socket's presence id (random; never the session). */
  id: string;
  ws: WebSocket;
  principal: Principal;
  token: string;
  subs: Map<string, Subscription>;
  bases: Map<string, BaseState>;
  alive: boolean;
  idleSince: number | undefined;
  tokens: number;
  refilledAt: number;
  refusals: number;
  presenceTokens: number;
  presenceRefilledAt: number;
}

/** Someone on a view: one of this process's sockets (`client`) or another process's. */
interface PresenceEntry {
  workspaceId: string;
  peer: PresencePeer;
  client: Client | undefined;
  /** When another process last announced it (for the TTL). */
  seenAt: number;
}

const samePresence = (a: PresenceState, b: PresenceState) =>
  a.recordId === b.recordId &&
  a.fieldId === b.fieldId &&
  a.editing === b.editing &&
  a.expandedRecordId === b.expandedRecordId;

const targetKey = (t: RealtimeTarget) =>
  'tableId' in t ? `table:${t.tableId}` : `view:${t.viewId}`;

/** Base structure events every subscription of the base receives (the sidebar). */
const BASE_WIDE = /^(base|table)\./;

function reject(socket: Duplex, status: number, text: string) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * The WebSocket gateway on `/ws` (ADR-003 §6). It isn't an HTTP route, so it does what the
 * route registry would: the upgrade needs the app's own `Origin` (no Origin, no upgrade) and a
 * live session cookie, as `requireSession` checks it; nothing is read from the query string.
 * Each subscription is authorized like `GET` on the table or view (`record:read`/`view:read`
 * through `authorize`), and checked again when access changes in its workspace, when its base,
 * table or view is deleted, and every `recheckMs`. Events go through `projectEvent`.
 */
export class RealtimeGateway {
  readonly #wss: WebSocketServer;
  readonly #clients = new Set<Client>();
  readonly #limits: RealtimeLimits;
  readonly #timers: NodeJS.Timeout[];
  readonly #offAccess: () => void;
  readonly #offPresence: () => void;
  readonly #offNotifications: () => void;
  /** Who is on each view, by view id then connection id: local sockets and other processes'. */
  readonly #peers = new Map<string, Map<string, PresenceEntry>>();

  constructor(
    private readonly deps: {
      db: Database;
      store: SessionStore;
      bus: EventBus;
      appUrl: string;
      logger: Logger;
      visibility?: FieldVisibility;
      limits?: Partial<RealtimeLimits>;
    }
  ) {
    this.#limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.#limits.maxMessageBytes,
      perMessageDeflate: false,
    });
    this.#offAccess = deps.bus.onAccessChange((workspaceId) => this.#recheckWorkspace(workspaceId));
    this.#offPresence = deps.bus.onPresence((messages) => this.#remotePresence(messages));
    // a hint to refetch the unread count, to every socket of the recipient.
    this.#offNotifications = deps.bus.onNotification((userId) => {
      for (const client of this.#clients) {
        if (client.principal.user.id === userId) this.#send(client, { type: 'notifications' });
      }
    });
    this.#timers = [
      setInterval(() => this.#heartbeat(), this.#limits.heartbeatMs),
      setInterval(() => void this.#recheckAll(), this.#limits.recheckMs),
      setInterval(() => this.#refreshPresence(), this.#limits.presenceRefreshMs),
    ];
    for (const t of this.#timers) t.unref();
  }

  /** Open sockets, for tests and metrics. */
  get connections(): number {
    return this.#clients.size;
  }

  /** The `upgrade` handler of the HTTP server. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    void this.#upgrade(req, socket, head).catch((err: unknown) => {
      this.deps.logger.error({ err }, 'realtime: upgrade failed');
      reject(socket, 500, 'Internal Server Error');
    });
  }

  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws') return reject(socket, 404, 'Not Found');
    if (req.headers.origin !== this.deps.appUrl) return reject(socket, 403, 'Forbidden');
    const token = parseCookies(req.headers.cookie ?? '', SESSION_COOKIE)[SESSION_COOKIE];
    const principal = token ? await this.deps.store.resolve(token, this.deps.logger) : null;
    if (!token || !principal) return reject(socket, 401, 'Unauthorized');
    const open = [...this.#clients].filter((c) => c.principal.user.id === principal.user.id);
    if (open.length >= this.#limits.maxConnectionsPerUser) {
      return reject(socket, 429, 'Too Many Requests');
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, principal, token));
  }

  #accept(ws: WebSocket, principal: Principal, token: string) {
    const client: Client = {
      id: randomUUID(),
      ws,
      principal,
      token,
      subs: new Map(),
      bases: new Map(),
      alive: true,
      idleSince: Date.now(),
      tokens: this.#limits.messagesPerSecond * 2,
      refilledAt: Date.now(),
      refusals: 0,
      presenceTokens: this.#limits.presencePerSecond * 2,
      presenceRefilledAt: Date.now(),
    };
    this.#clients.add(client);
    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => this.#message(client, data, isBinary));
    ws.on('close', () => this.#drop(client));
    ws.on('error', () => ws.terminate());
    this.#send(client, { type: 'ready', userId: principal.user.id });
  }

  #drop(client: Client) {
    this.#clients.delete(client);
    for (const sub of client.subs.values()) {
      if ('viewId' in sub.target) this.#leave(client, sub.target.viewId);
    }
    for (const state of client.bases.values()) {
      if (state.watch) state.watch.stop();
      else
        void state.ready.then(
          (w) => w.stop(),
          () => {}
        );
    }
    client.bases.clear();
    client.subs.clear();
  }

  #send(client: Client, message: RealtimeServerMessage) {
    if (client.ws.readyState !== client.ws.OPEN) return;
    if (client.ws.bufferedAmount > this.#limits.maxBufferedBytes) {
      client.ws.close(CLOSE.TOO_SLOW, 'too slow');
      return;
    }
    client.ws.send(JSON.stringify(message));
  }

  #error(client: Client, code: RealtimeErrorCode, message: string, target?: RealtimeTarget) {
    this.#send(client, { type: 'error', code, message, ...(target ? { target } : {}) });
  }

  #refuse(client: Client, code: RealtimeErrorCode, message: string, target?: RealtimeTarget) {
    client.refusals += 1;
    this.#error(client, code, message, target);
    if (client.refusals > this.#limits.maxRefusals)
      client.ws.close(CLOSE.POLICY, 'too many errors');
  }

  /** Token bucket: `messagesPerSecond`, with a burst of twice that. */
  #allow(client: Client): boolean {
    const now = Date.now();
    const rate = this.#limits.messagesPerSecond;
    client.tokens = Math.min(rate * 2, client.tokens + ((now - client.refilledAt) / 1000) * rate);
    client.refilledAt = now;
    if (client.tokens < 1) return false;
    client.tokens -= 1;
    return true;
  }

  #message(client: Client, data: unknown, isBinary: boolean) {
    if (!this.#allow(client)) return this.#refuse(client, 'RATE_LIMITED', 'Slow down.');
    let parsed: unknown;
    try {
      if (isBinary) throw new Error('binary');
      parsed = JSON.parse(String(data));
    } catch {
      return this.#refuse(client, 'BAD_MESSAGE', 'Messages are JSON text.');
    }
    const result = realtimeClientMessageSchema.safeParse(parsed);
    if (!result.success)
      return this.#refuse(client, 'BAD_MESSAGE', 'Unknown or malformed message.');
    const message = result.data;
    if (message.type === 'ping') return this.#send(client, { type: 'pong' });
    if (message.type === 'presence') {
      // An impersonating admin is invisible: they mustn't show up as the user.
      if (client.principal.impersonation) return;
      return this.#presence(client, message.viewId, message.state);
    }
    if (message.type === 'unsubscribe') {
      this.#unsubscribe(client, targetKey(message.target));
      return this.#send(client, { type: 'unsubscribed', target: message.target });
    }
    void this.#subscribe(client, message.target).catch((err: unknown) => {
      this.deps.logger.error({ err }, 'realtime: subscribe failed');
      this.#error(client, 'INTERNAL_ERROR', 'Could not subscribe. Try again.', message.target);
    });
  }

  /**
   * Resolves and authorizes a target as its REST read would: the table (`record:read`) or the
   * view (`view:read`; another user's personal view doesn't exist for you). Null when refused:
   * missing, in the trash, another tenant's or not visible all look the same.
   */
  async #authorize(principal: Principal, target: RealtimeTarget): Promise<Access> {
    const userId = principal.user.id;
    const [kind, id, action]: ['table' | 'view', string, Action] =
      'tableId' in target
        ? ['table', target.tableId, 'record:read']
        : ['view', target.viewId, 'view:read'];
    const resolved = await resolveResource(this.deps.db, kind, id, userId);
    const decision = authorize(principal, action, resolved);
    if (!decision.allowed || !resolved?.baseId) {
      return {
        denied: !decision.allowed && decision.reason === 'forbidden' ? 'FORBIDDEN' : 'NOT_FOUND',
      };
    }
    let tableId = id;
    if (kind === 'view') {
      const [view] = await inScope(
        this.deps.db,
        { userId, workspaceId: resolved.workspaceId },
        (tx) =>
          tx
            .select({ tableId: views.tableId })
            .from(views)
            .where(and(eq(views.id, id), visibleTo(userId)))
      );
      if (!view) return { denied: 'NOT_FOUND' };
      tableId = view.tableId;
    }
    return {
      workspaceId: resolved.workspaceId,
      baseId: resolved.baseId,
      tableId,
      role: decision.role,
    };
  }

  async #subscribe(client: Client, target: RealtimeTarget) {
    const key = targetKey(target);
    if (!client.subs.has(key) && client.subs.size >= this.#limits.maxSubscriptions) {
      return this.#refuse(
        client,
        'TOO_MANY_SUBSCRIPTIONS',
        `At most ${this.#limits.maxSubscriptions} subscriptions per connection.`,
        target
      );
    }
    const access = await this.#authorize(client.principal, target);
    if ('denied' in access) {
      const message = access.denied === 'FORBIDDEN' ? 'Not allowed.' : 'No such table or view.';
      return this.#refuse(client, access.denied, message, target);
    }
    if (!this.#clients.has(client)) return;
    let state = client.bases.get(access.baseId);
    if (!state) {
      const created: BaseState = {
        ready: this.deps.bus.watch(
          { baseId: access.baseId, workspaceId: access.workspaceId },
          (rows) => this.#deliver(client, access.baseId, rows)
        ),
        watch: undefined,
      };
      state = created;
      client.bases.set(access.baseId, created);
      created.ready.then(
        (w) => {
          created.watch = w;
        },
        () => {
          if (client.bases.get(access.baseId) === created) client.bases.delete(access.baseId);
        }
      );
    }
    await state.ready;
    // The socket may have closed or unsubscribed meanwhile.
    if (!this.#clients.has(client) || client.bases.get(access.baseId) !== state) return;
    client.subs.set(key, { key, target, ...access });
    client.idleSince = undefined;
    // Synchronous with the bus: events after this seq reach the socket, earlier ones are catch-up.
    const seq = this.deps.bus.position(access.baseId) ?? 0;
    this.#send(client, {
      type: 'subscribed',
      target,
      baseId: access.baseId,
      tableId: access.tableId,
      seq,
    });
    if ('viewId' in target) this.#join(client, target.viewId, access.workspaceId);
  }

  #unsubscribe(client: Client, key: string) {
    const sub = client.subs.get(key);
    if (!sub) return;
    client.subs.delete(key);
    if ('viewId' in sub.target) this.#leave(client, sub.target.viewId);
    if (![...client.subs.values()].some((s) => s.baseId === sub.baseId)) {
      const state = client.bases.get(sub.baseId);
      client.bases.delete(sub.baseId);
      if (state?.watch) state.watch.stop();
      else
        void state?.ready.then(
          (w) => w.stop(),
          () => {}
        );
    }
    if (client.subs.size === 0) client.idleSince = Date.now();
  }

  #deliver(client: Client, baseId: string, rows: readonly OutboxRow[]) {
    const subs = [...client.subs.values()].filter((s) => s.baseId === baseId);
    const first = subs[0];
    if (!first) return;
    const tables = new Set(subs.map((s) => s.tableId));
    const viewer = { userId: client.principal.user.id, role: first.role };
    let removed = false;
    for (const row of rows) {
      if (!(BASE_WIDE.test(row.kind) || (row.tableId !== null && tables.has(row.tableId))))
        continue;
      const event = projectEvent(row, viewer, this.deps.visibility ?? allFieldsVisible);
      if (event) this.#send(client, { type: 'event', event });
      if (/^(base|table|view)\.deleted$/.test(row.kind)) removed = true;
    }
    if (removed) void this.#recheck(client, (s) => s.baseId === baseId);
  }

  /** Checks `client`'s matching subscriptions again; drops (`revoked`) those no longer allowed. */
  async #recheck(client: Client, which: (s: Subscription) => boolean) {
    for (const sub of [...client.subs.values()].filter(which)) {
      let access: Access;
      try {
        access = await this.#authorize(client.principal, sub.target);
      } catch (err) {
        this.deps.logger.warn({ err }, 'realtime: access re-check failed');
        continue;
      }
      if (client.subs.get(sub.key) !== sub) continue;
      if ('denied' in access) {
        this.#unsubscribe(client, sub.key);
        this.#send(client, { type: 'revoked', target: sub.target });
      } else {
        sub.role = access.role;
      }
    }
  }

  async #recheckWorkspace(workspaceId: string) {
    await Promise.all(
      [...this.#clients].map((c) => this.#recheck(c, (s) => s.workspaceId === workspaceId))
    );
  }

  /** Ends sockets whose session ended (sign-out, expiry) and re-checks every subscription. */
  async #recheckAll() {
    for (const client of [...this.#clients]) {
      try {
        const principal = await this.deps.store.resolve(client.token, this.deps.logger);
        if (!principal) {
          client.ws.close(CLOSE.SESSION_ENDED, 'session ended');
          continue;
        }
        client.principal = principal;
        await this.#recheck(client, () => true);
      } catch (err) {
        this.deps.logger.warn({ err }, 'realtime: periodic re-check failed');
      }
    }
  }

  #heartbeat() {
    const now = Date.now();
    for (const client of this.#clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      if (client.idleSince !== undefined && now - client.idleSince >= this.#limits.idleMs) {
        client.ws.close(CLOSE.IDLE, 'idle');
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }

  // Presence (ADR-003 §8). A view subscription joins the view's presence with an empty
  // state; `presence` messages update it; unsubscribing, losing access or closing leaves it.
  // Changes reach this process's sockets at once and the other processes over the bus. A socket
  // only ever receives presence for a view it holds an authorized subscription to (in the
  // view's workspace), and never its own user's.

  #peer(client: Client, state: PresenceState): PresencePeer {
    const name = displayName(client.principal.user, false).slice(0, PRESENCE_MAX_NAME);
    return {
      connectionId: client.id,
      userId: client.principal.user.id,
      name,
      initials: userInitials(name),
      color: userColor(client.principal.user.id),
      state,
    };
  }

  /** Sends `message` to this process's sockets on `viewId`, except `userId`'s. */
  #toView(viewId: string, workspaceId: string, userId: string, message: RealtimeServerMessage) {
    const key = targetKey({ viewId });
    for (const other of this.#clients) {
      if (other.principal.user.id === userId) continue;
      const sub = other.subs.get(key);
      if (sub && sub.workspaceId === workspaceId) this.#send(other, message);
    }
  }

  /** Stores an entry and shares it here; false when the view is full. */
  #upsert(viewId: string, entry: PresenceEntry): boolean {
    let peers = this.#peers.get(viewId);
    const known = peers?.get(entry.peer.connectionId);
    if (!known && (peers?.size ?? 0) >= this.#limits.maxPeersPerView) return false;
    if (!peers) {
      peers = new Map();
      this.#peers.set(viewId, peers);
    }
    peers.set(entry.peer.connectionId, entry);
    if (known && samePresence(known.peer.state, entry.peer.state)) return true;
    this.#toView(viewId, entry.workspaceId, entry.peer.userId, {
      type: 'presence',
      viewId,
      peer: entry.peer,
    });
    return true;
  }

  #remove(viewId: string, connectionId: string): PresenceEntry | undefined {
    const peers = this.#peers.get(viewId);
    const entry = peers?.get(connectionId);
    if (!peers || !entry) return undefined;
    peers.delete(connectionId);
    if (peers.size === 0) this.#peers.delete(viewId);
    this.#toView(viewId, entry.workspaceId, entry.peer.userId, {
      type: 'presenceLeft',
      viewId,
      connectionId,
    });
    return entry;
  }

  /** A new view subscription: who is already there, then the socket itself joins. */
  #join(client: Client, viewId: string, workspaceId: string) {
    for (const entry of this.#peers.get(viewId)?.values() ?? []) {
      if (entry.workspaceId !== workspaceId || entry.peer.userId === client.principal.user.id)
        continue;
      this.#send(client, { type: 'presence', viewId, peer: entry.peer });
    }
    // Subscribing again keeps the state.
    const own = this.#peers.get(viewId)?.get(client.id);
    const peer = this.#peer(client, own?.client === client ? own.peer.state : EMPTY_PRESENCE);
    if (this.#upsert(viewId, { workspaceId, peer, client, seenAt: Date.now() })) {
      this.deps.bus.publishPresence({ op: 'upsert', workspaceId, viewId, peer });
    }
  }

  #leave(client: Client, viewId: string) {
    const entry = this.#peers.get(viewId)?.get(client.id);
    if (entry?.client !== client) return;
    this.#remove(viewId, client.id);
    this.deps.bus.publishPresence({
      op: 'leave',
      workspaceId: entry.workspaceId,
      viewId,
      connectionId: client.id,
    });
  }

  /** Token bucket for presence messages: `presencePerSecond`, with a burst of twice that. */
  #allowPresence(client: Client): boolean {
    const now = Date.now();
    const rate = this.#limits.presencePerSecond;
    client.presenceTokens = Math.min(
      rate * 2,
      client.presenceTokens + ((now - client.presenceRefilledAt) / 1000) * rate
    );
    client.presenceRefilledAt = now;
    if (client.presenceTokens < 1) return false;
    client.presenceTokens -= 1;
    return true;
  }

  #presence(client: Client, viewId: string, state: PresenceState) {
    if (!this.#allowPresence(client)) {
      return this.#refuse(client, 'RATE_LIMITED', 'Too many presence updates.');
    }
    const target = { viewId };
    const sub = client.subs.get(targetKey(target));
    if (!sub) return this.#refuse(client, 'NOT_SUBSCRIBED', 'Subscribe to the view first.', target);
    const entry = this.#peers.get(viewId)?.get(client.id);
    // A full view: this socket isn't shown there.
    if (entry?.client !== client) return;
    // Only people who may edit records can be "editing" a cell.
    const editing = state.editing && roleAllows(sub.role, 'record:update');
    const peer = this.#peer(client, { ...state, editing });
    this.#upsert(viewId, { ...entry, peer });
    this.deps.bus.publishPresence({ op: 'upsert', workspaceId: sub.workspaceId, viewId, peer });
  }

  /** Changes from the other processes. */
  #remotePresence(messages: readonly PresenceBusMessage[]) {
    const now = Date.now();
    for (const message of messages) {
      if (message.op === 'leave') {
        if (!this.#peers.get(message.viewId)?.get(message.connectionId)?.client) {
          this.#remove(message.viewId, message.connectionId);
        }
        continue;
      }
      const known = this.#peers.get(message.viewId)?.get(message.peer.connectionId);
      if (known?.client) continue;
      this.#upsert(message.viewId, {
        workspaceId: message.workspaceId,
        peer: message.peer,
        client: undefined,
        seenAt: now,
      });
    }
  }

  /** Re-announces this process's entries and drops the other processes' stale ones. */
  #refreshPresence() {
    const now = Date.now();
    for (const [viewId, peers] of [...this.#peers]) {
      for (const entry of [...peers.values()]) {
        if (entry.client) {
          this.deps.bus.publishPresence({
            op: 'upsert',
            workspaceId: entry.workspaceId,
            viewId,
            peer: entry.peer,
          });
        } else if (now - entry.seenAt > this.#limits.presenceTtlMs) {
          this.#remove(viewId, entry.peer.connectionId);
        }
      }
    }
  }

  /** Test hook: runs the periodic presence refresh and expiry now. */
  refreshPresence(): void {
    this.#refreshPresence();
  }

  /** Test hook: runs the periodic checks now. */
  runChecks(): Promise<void> {
    return this.#recheckAll();
  }

  async close(): Promise<void> {
    this.#offAccess();
    this.#offPresence();
    this.#offNotifications();
    for (const t of this.#timers) clearInterval(t);
    for (const client of [...this.#clients])
      client.ws.close(CLOSE.GOING_AWAY, 'server shutting down');
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }
}
