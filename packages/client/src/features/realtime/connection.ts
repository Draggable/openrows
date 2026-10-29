import {
  type EventList,
  type PresencePeer,
  type PresenceState,
  type RealtimeClientMessage,
  type RealtimeEvent,
  type RealtimeServerMessage,
  type RealtimeTarget,
  realtimeServerMessageSchema,
} from '@openrows/shared';

/**
 * The tab's one realtime connection (ADR-003 §5–7), free of React so it can be tested with
 * a fake socket. Components subscribe to targets (a table or a view, ref-counted); the socket
 * opens with the first subscription and is re-opened with exponential backoff and jitter when
 * it drops. Events are delivered in `seq` order per base, once each: after a reconnect, the
 * events missed meanwhile come from the catch-up endpoint (`since=<last seq>`) while the new
 * socket's events wait in a buffer, and seqs already seen are dropped. When the catch-up can't
 * fill the gap (410: past the retention window, or any other failure) the base is resynced:
 * the caller refetches what it shows.
 */

export type ConnectionStatus =
  /** No subscription, no socket. */
  | 'idle'
  /** Opening the first socket (or retrying one that never came up). */
  | 'connecting'
  | 'live'
  /** Was live and lost the socket; retrying. */
  | 'reconnecting'
  /** The browser says it's offline; waits for it to come back. */
  | 'offline';

/** The part of `WebSocket` the connection uses (a fake one in tests). */
export type SocketLike = Pick<WebSocket, 'send' | 'close' | 'onmessage' | 'onclose'>;

export interface ConnectionDeps {
  createSocket: () => SocketLike;
  /** One page of `GET /api/bases/:baseId/events?since=`; `'expired'` for a 410. */
  fetchEvents: (baseId: string, since: number) => Promise<EventList | 'expired'>;
  /** Called with events in seq order per base, each once. */
  onEvents: (events: RealtimeEvent[]) => void;
  /** The missed events of `baseId` are gone: refetch everything shown from it. */
  onResync: (baseId: string) => void;
  /** Access to a target was lost (the server dropped the subscription). */
  onRevoked?: (target: RealtimeTarget) => void;
  /** The server closed the socket because the session ended (4401). */
  onSessionEnded?: () => void;
  /** The user's notifications changed: refetch the unread count. */
  onNotifications?: () => void;
  isOnline?: () => boolean;
  random?: () => number;
  now?: () => number;
}

/** Backoff: 500 ms doubling to 30 s, times a random 50–100 %. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30_000;
/** An application ping this often; a socket silent for `DEAD_AFTER_MS` is dropped. */
export const PING_EVERY_MS = 25_000;
export const DEAD_AFTER_MS = 40_000;
/** The socket closes this long after the last subscription left (if none came back). */
export const IDLE_CLOSE_MS = 30_000;

const SESSION_ENDED = 4401;

/** Presence goes out at most this often (the server allows 10 a second, burst 20). */
export const PRESENCE_EVERY_MS = 120;

const NO_PEERS: readonly PresencePeer[] = [];

export const targetKey = (t: RealtimeTarget) =>
  'tableId' in t ? `table:${t.tableId}` : `view:${t.viewId}`;

interface Wanted {
  target: RealtimeTarget;
  count: number;
}

/** What the connection knows about one base's event stream. */
interface BaseStream {
  /** The last seq applied (or caught up past). */
  lastSeq: number;
  /** The seq of the latest `subscribed`: socket events start after it. */
  position: number;
  /** Set when the socket dropped: the next `subscribed` starts a catch-up from `lastSeq`. */
  resume: boolean;
  catchingUp: boolean;
  /** Another resume was asked for while catching up: read once more at the end. */
  again: boolean;
  /** Socket events that arrived during the catch-up, applied after it. */
  buffer: RealtimeEvent[];
}

export class RealtimeConnection {
  readonly #deps: ConnectionDeps;
  readonly #wanted = new Map<string, Wanted>();
  /** Targets the current socket has a subscription for (or asked for), by key → base id. */
  readonly #sent = new Map<string, string | null>();
  readonly #bases = new Map<string, BaseStream>();
  /**
   * Targets that were wanted when a socket dropped before their `subscribed` came: the data on
   * screen may predate events no seq can resume from, so the first `subscribed` resyncs.
   */
  readonly #unconfirmed = new Set<string>();
  readonly #listeners = new Set<(status: ConnectionStatus) => void>();
  #socket: SocketLike | null = null;
  #ready = false;
  #status: ConnectionStatus = 'idle';
  #wasLive = false;
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #idleClose: ReturnType<typeof setTimeout> | undefined;
  #pinger: ReturnType<typeof setInterval> | undefined;
  #lastHeard = 0;
  #disposed = false;
  /** This tab's presence per view, sent while subscribed to the view. */
  readonly #presence = new Map<string, PresenceState>();
  /** Views whose presence changed since it was last sent. */
  readonly #presenceDirty = new Set<string>();
  #presenceSentAt = Number.NEGATIVE_INFINITY;
  #presenceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Other people on each view (never this user), as the server reports them. */
  readonly #peers = new Map<string, readonly PresencePeer[]>();
  readonly #peerListeners = new Set<() => void>();
  /** Extensions' record watchers: the tables that changed, or null after a resync. */
  readonly #changeListeners = new Set<(tableIds: readonly string[] | null) => void>();

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  /** Calls `listener` on every status change; answers the unsubscribe. */
  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Wants `target`'s events until the returned function is called (ref-counted). */
  subscribe(target: RealtimeTarget): () => void {
    const key = targetKey(target);
    clearTimeout(this.#idleClose);
    this.#idleClose = undefined;
    const wanted = this.#wanted.get(key);
    if (wanted) wanted.count++;
    else {
      this.#wanted.set(key, { target, count: 1 });
      if (this.#ready) this.#subscribeOnSocket(key, target);
      else this.#ensureSocket();
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#release(key);
    };
  }

  /**
   * This tab's presence on `viewId`: the selected cell, an open editor, the expanded
   * record. Sent (throttled, latest wins) while the view is subscribed, again after a
   * reconnect; `null` forgets it (the server has an empty state for every subscriber).
   */
  setPresence(viewId: string, state: PresenceState | null): void {
    if (state === null) {
      this.#presence.delete(viewId);
      this.#presenceDirty.delete(viewId);
      return;
    }
    const current = this.#presence.get(viewId);
    if (
      current &&
      current.recordId === state.recordId &&
      current.fieldId === state.fieldId &&
      current.editing === state.editing &&
      current.expandedRecordId === state.expandedRecordId
    )
      return;
    this.#presence.set(viewId, state);
    this.#presenceDirty.add(viewId);
    this.#flushPresenceSoon();
  }

  /** Who else is on `viewId` (a stable array between changes). */
  peers(viewId: string): readonly PresencePeer[] {
    return this.#peers.get(viewId) ?? NO_PEERS;
  }

  /**
   * Calls `listener` with the tables events touched (after the caches have them queued), or
   * null when missed events forced a resync; answers the unsubscribe.
   */
  onChanges(listener: (tableIds: readonly string[] | null) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  #changed(tableIds: readonly string[] | null) {
    for (const listener of this.#changeListeners) listener(tableIds);
  }

  /** Calls `listener` when anyone's presence changes; answers the unsubscribe. */
  onPeers(listener: () => void): () => void {
    this.#peerListeners.add(listener);
    return () => this.#peerListeners.delete(listener);
  }

  #setPeers(viewId: string, peers: readonly PresencePeer[]) {
    if (peers.length === 0) {
      if (!this.#peers.delete(viewId)) return;
    } else this.#peers.set(viewId, peers);
    for (const listener of this.#peerListeners) listener();
  }

  #clearPeers() {
    if (this.#peers.size === 0) return;
    this.#peers.clear();
    for (const listener of this.#peerListeners) listener();
  }

  #flushPresenceSoon() {
    if (this.#presenceTimer || this.#presenceDirty.size === 0) return;
    const wait = Math.max(0, this.#presenceSentAt + PRESENCE_EVERY_MS - this.#now());
    if (wait === 0) return this.#flushPresence();
    this.#presenceTimer = setTimeout(() => {
      this.#presenceTimer = undefined;
      this.#flushPresence();
    }, wait);
  }

  /** Sends the changed states of the subscribed views; the others wait for `subscribed`. */
  #flushPresence() {
    if (!this.#ready) return;
    let sent = false;
    for (const viewId of [...this.#presenceDirty]) {
      const state = this.#presence.get(viewId);
      if (!state) {
        this.#presenceDirty.delete(viewId);
        continue;
      }
      if (!this.#sent.get(targetKey({ viewId }))) continue;
      this.#presenceDirty.delete(viewId);
      this.#send({ type: 'presence', viewId, state });
      sent = true;
    }
    if (sent) this.#presenceSentAt = this.#now();
  }

  /** The browser came back online: reconnect now rather than at the next backoff step. */
  online(): void {
    if (this.#disposed || this.#socket || this.#wanted.size === 0) return;
    clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#attempt = 0;
    this.#open();
  }

  /** The browser went offline: drop the socket (it resumes when back online). */
  offline(): void {
    if (this.#disposed) return;
    this.#setStatus('offline');
    this.#socket?.close(1000, 'offline');
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#idleClose);
    clearInterval(this.#pinger);
    clearTimeout(this.#presenceTimer);
    this.#wanted.clear();
    const socket = this.#socket;
    this.#dropSocket();
    socket?.close(1000, 'done');
    this.#setStatus('idle');
  }

  #release(key: string) {
    const wanted = this.#wanted.get(key);
    if (!wanted) return;
    if (--wanted.count > 0) return;
    this.#wanted.delete(key);
    this.#unconfirmed.delete(key);
    if ('viewId' in wanted.target) this.#setPeers(wanted.target.viewId, []);
    const baseId = this.#sent.get(key);
    if (this.#sent.delete(key) && this.#ready) {
      this.#send({ type: 'unsubscribe', target: wanted.target });
    }
    // A base nothing is subscribed to any more is forgotten: its caches refetch when shown again.
    if (baseId && ![...this.#sent.values()].includes(baseId)) this.#bases.delete(baseId);
    if (this.#wanted.size === 0) {
      this.#bases.clear();
      clearTimeout(this.#retry);
      this.#retry = undefined;
      if (!this.#socket) this.#setStatus('idle');
      else this.#idleClose = setTimeout(() => this.#closeIdle(), IDLE_CLOSE_MS);
    }
  }

  #closeIdle() {
    this.#idleClose = undefined;
    const socket = this.#socket;
    if (this.#wanted.size > 0 || !socket) return;
    this.#dropSocket();
    socket.close(1000, 'idle');
    this.#setStatus('idle');
  }

  #setStatus(status: ConnectionStatus) {
    if (status === this.#status) return;
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }

  #ensureSocket() {
    if (this.#socket || this.#retry || this.#disposed) return;
    if (this.#deps.isOnline && !this.#deps.isOnline()) return this.#setStatus('offline');
    this.#open();
  }

  #open() {
    this.#setStatus(this.#wasLive ? 'reconnecting' : 'connecting');
    let socket: SocketLike;
    try {
      socket = this.#deps.createSocket();
    } catch {
      return this.#scheduleRetry();
    }
    this.#socket = socket;
    socket.onmessage = (ev) => {
      if (this.#socket === socket) this.#onMessage(ev.data);
    };
    socket.onclose = (ev) => {
      if (this.#socket === socket) this.#onClose(ev.code);
    };
  }

  #now() {
    return this.#deps.now?.() ?? Date.now();
  }

  #onMessage(data: unknown) {
    this.#lastHeard = this.#now();
    let message: RealtimeServerMessage;
    try {
      message = realtimeServerMessageSchema.parse(JSON.parse(String(data)));
    } catch {
      return;
    }
    switch (message.type) {
      case 'ready':
        return this.#onReady();
      case 'subscribed':
        return this.#onSubscribed(targetKey(message.target), message.baseId, message.seq);
      case 'event':
        return this.#onEvent(message.event);
      case 'revoked': {
        const key = targetKey(message.target);
        this.#sent.delete(key);
        if ('viewId' in message.target) this.#setPeers(message.target.viewId, []);
        return this.#deps.onRevoked?.(message.target);
      }
      case 'presence': {
        const { viewId, peer } = message;
        if (!this.#wanted.has(targetKey({ viewId }))) return;
        const peers = this.peers(viewId);
        // Keeps the order people arrived in.
        return this.#setPeers(
          viewId,
          peers.some((p) => p.connectionId === peer.connectionId)
            ? peers.map((p) => (p.connectionId === peer.connectionId ? peer : p))
            : [...peers, peer]
        );
      }
      case 'notifications':
        return this.#deps.onNotifications?.();
      case 'presenceLeft': {
        const peers = this.peers(message.viewId);
        const rest = peers.filter((p) => p.connectionId !== message.connectionId);
        if (rest.length !== peers.length) this.#setPeers(message.viewId, rest);
        return;
      }
      case 'error':
        // A refused subscription (gone, no access) isn't retried until the next socket.
        if (message.target && (message.code === 'NOT_FOUND' || message.code === 'FORBIDDEN')) {
          this.#deps.onRevoked?.(message.target);
        }
        return;
      default:
        return;
    }
  }

  #onReady() {
    this.#ready = true;
    this.#attempt = 0;
    this.#wasLive = true;
    this.#setStatus('live');
    clearInterval(this.#pinger);
    this.#pinger = setInterval(() => this.#keepAlive(), PING_EVERY_MS);
    for (const [key, { target }] of this.#wanted) this.#subscribeOnSocket(key, target);
  }

  #keepAlive() {
    const socket = this.#socket;
    if (!socket) return;
    if (this.#now() - this.#lastHeard > DEAD_AFTER_MS) {
      // A dead network path may never fire `close`: give up on this socket ourselves.
      this.#onClose(1006);
      socket.close(4000, 'no answer');
      return;
    }
    this.#send({ type: 'ping' });
  }

  #subscribeOnSocket(key: string, target: RealtimeTarget) {
    this.#sent.set(key, null);
    this.#send({ type: 'subscribe', target });
  }

  #send(message: RealtimeClientMessage) {
    try {
      this.#socket?.send(JSON.stringify(message));
    } catch {
      // Closing; the close handler reconnects.
    }
  }

  #onSubscribed(key: string, baseId: string, seq: number) {
    const wanted = this.#wanted.get(key);
    if (!wanted) return;
    this.#sent.set(key, baseId);
    const unconfirmed = this.#unconfirmed.delete(key);
    if ('viewId' in wanted.target && this.#presence.has(wanted.target.viewId)) {
      // The server starts every subscriber empty: send this tab's state again.
      this.#presenceDirty.add(wanted.target.viewId);
      this.#flushPresenceSoon();
    }
    const stream = this.#bases.get(baseId);
    if (!stream) {
      // First subscription in this base: the data on screen was just fetched, unless an earlier
      // socket dropped before confirming it (then what changed meanwhile is unknown).
      this.#bases.set(baseId, {
        lastSeq: seq,
        position: seq,
        resume: false,
        catchingUp: false,
        again: false,
        buffer: [],
      });
      if (unconfirmed) {
        this.#deps.onResync(baseId);
        this.#changed(null);
      }
      return;
    }
    stream.position = Math.max(stream.position, seq);
    if (!stream.resume) return;
    stream.resume = false;
    if (stream.catchingUp) stream.again = true;
    else void this.#catchUp(baseId, stream);
  }

  #onEvent(event: RealtimeEvent) {
    const stream = this.#bases.get(event.baseId);
    if (!stream) return;
    if (stream.catchingUp) {
      stream.buffer.push(event);
      return;
    }
    this.#apply(stream, [event]);
  }

  /** Delivers the events newer than the stream's last seq, in order. */
  #apply(stream: BaseStream, events: readonly RealtimeEvent[]) {
    const fresh: RealtimeEvent[] = [];
    for (const event of events) {
      if (event.seq <= stream.lastSeq) continue;
      stream.lastSeq = event.seq;
      fresh.push(event);
    }
    if (fresh.length === 0) return;
    this.#deps.onEvents(fresh);
    const tables = new Set<string>();
    for (const event of fresh) if (event.tableId) tables.add(event.tableId);
    if (tables.size > 0) this.#changed([...tables]);
  }

  async #catchUp(baseId: string, stream: BaseStream) {
    stream.catchingUp = true;
    try {
      do {
        stream.again = false;
        let hasMore = true;
        while (hasMore) {
          const since = stream.lastSeq;
          const page = await this.#deps.fetchEvents(baseId, since);
          if (this.#bases.get(baseId) !== stream) return;
          if (page === 'expired') throw new Error('expired');
          this.#apply(stream, page.events);
          // Filtered-out events advance `next` too.
          stream.lastSeq = Math.max(stream.lastSeq, page.next);
          hasMore = page.hasMore && page.next > since;
        }
      } while (stream.again);
    } catch {
      if (this.#bases.get(baseId) !== stream) return;
      // The gap can't be filled: start from what the socket sends now and refetch the rest.
      stream.lastSeq = Math.max(stream.lastSeq, stream.position);
      this.#deps.onResync(baseId);
      this.#changed(null);
    } finally {
      stream.catchingUp = false;
    }
    const buffered = stream.buffer.splice(0);
    this.#apply(stream, buffered);
  }

  #dropSocket() {
    for (const key of this.#wanted.keys()) {
      if (!this.#sent.get(key)) this.#unconfirmed.add(key);
    }
    this.#socket = null;
    this.#ready = false;
    this.#sent.clear();
    // The next socket's subscriptions bring who is there again.
    this.#clearPeers();
    clearInterval(this.#pinger);
    this.#pinger = undefined;
    for (const stream of this.#bases.values()) stream.resume = true;
  }

  #onClose(code: number) {
    this.#dropSocket();
    if (this.#disposed) return;
    if (code === SESSION_ENDED) this.#deps.onSessionEnded?.();
    if (this.#wanted.size === 0) return this.#setStatus('idle');
    if (this.#deps.isOnline && !this.#deps.isOnline()) return this.#setStatus('offline');
    this.#scheduleRetry();
  }

  #scheduleRetry() {
    this.#setStatus(this.#wasLive ? 'reconnecting' : 'connecting');
    const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.#attempt);
    this.#attempt++;
    const delay = step * (0.5 + (this.#deps.random?.() ?? Math.random()) / 2);
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      if (!this.#disposed && !this.#socket && this.#wanted.size > 0) this.#open();
    }, delay);
  }
}
