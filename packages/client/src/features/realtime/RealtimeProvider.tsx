import type { PresencePeer, RealtimeEvent, RealtimeTarget } from '@openrows/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { ApiError, api } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { applyRealtimeEvents, resyncCaches } from './apply';
import { type ConnectionStatus, RealtimeConnection } from './connection';

const RealtimeContext = createContext<RealtimeConnection | null>(null);

/** Events arriving within this window are applied to the caches in one pass. */
const BATCH_MS = 16;

/** The tab's connection, wired to the query cache, the catch-up endpoint and `/ws`. */
export function createRealtimeConnection(qc: ReturnType<typeof useQueryClient>) {
  let pending: RealtimeEvent[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const events = pending;
    pending = [];
    applyRealtimeEvents(qc, events);
  };
  return new RealtimeConnection({
    createSocket: () => new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`),
    fetchEvents: async (baseId, since) => {
      try {
        return await api.events.list({ params: { baseId }, query: { since } });
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) return 'expired';
        throw err;
      }
    },
    onEvents: (events) => {
      pending.push(...events);
      if (scheduled) return;
      scheduled = true;
      setTimeout(flush, BATCH_MS);
    },
    onResync: () => resyncCaches(qc),
    // Lost access: the queries refetch and show their error (404) instead of stale data.
    onRevoked: () => resyncCaches(qc),
    // Signed out elsewhere: `/api/me` refetches and the route guard goes to /login.
    onSessionEnded: () => void qc.invalidateQueries({ queryKey: queryKeys.me() }),
    // A new notification, or one read in another tab: the bell and the inbox refetch.
    onNotifications: () => void qc.invalidateQueries({ queryKey: queryKeys.notifications.all() }),
    isOnline: () => navigator.onLine,
  });
}

/**
 * One realtime connection per tab for everything under it. The socket only opens while a
 * component subscribes (`useRealtimeSubscription`), closes a while after the last one leaves,
 * and follows the browser's online state.
 */
export function RealtimeProvider({
  children,
  connection,
}: {
  children: ReactNode;
  /** Tests pass their own (with a fake socket). */
  connection?: RealtimeConnection;
}) {
  const qc = useQueryClient();
  const [conn] = useState(() => connection ?? createRealtimeConnection(qc));
  useEffect(() => {
    const online = () => conn.online();
    const offline = () => conn.offline();
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [conn]);
  return <RealtimeContext.Provider value={conn}>{children}</RealtimeContext.Provider>;
}

/** Live updates for `target` while the component is mounted (none without a provider). */
export function useRealtimeSubscription(target: RealtimeTarget | null): void {
  const conn = useContext(RealtimeContext);
  const tableId = target && 'tableId' in target ? target.tableId : undefined;
  const viewId = target && 'viewId' in target ? target.viewId : undefined;
  useEffect(() => {
    if (!conn) return;
    if (tableId) return conn.subscribe({ tableId });
    if (viewId) return conn.subscribe({ viewId });
  }, [conn, tableId, viewId]);
}

/** Live updates for several tables at once (a dashboard's); `key` is their ids joined. */
export function useRealtimeTables(tableIds: readonly string[]): void {
  const conn = useContext(RealtimeContext);
  const key = tableIds.join(',');
  useEffect(() => {
    if (!conn || !key) return;
    const stops = key.split(',').map((tableId) => conn.subscribe({ tableId }));
    return () => {
      for (const stop of stops) stop();
    };
  }, [conn, key]);
}

const idle = () => 'idle' as const;
const noop = () => () => {};

/** The connection's status, for the indicator and the offline banner. */
export function useRealtimeStatus(): ConnectionStatus {
  const conn = useContext(RealtimeContext);
  return useSyncExternalStore(
    conn ? (listener) => conn.onStatus(listener) : noop,
    conn ? () => conn.status : idle
  );
}

const NO_PEERS: readonly PresencePeer[] = [];

/** Other people on `viewId`, live; none without a provider. */
export function usePresencePeers(viewId: string | undefined): readonly PresencePeer[] {
  const conn = useContext(RealtimeContext);
  return useSyncExternalStore(
    conn ? (listener) => conn.onPeers(listener) : noop,
    conn && viewId ? () => conn.peers(viewId) : () => NO_PEERS
  );
}

/** The tab's connection, for the presence publisher (null without a provider). */
export const useRealtimeConnection = () => useContext(RealtimeContext);

/**
 * Calls `listener` with the tables live events changed, or null after a resync (the
 * extension panel's record watchers). Keep `listener` stable.
 */
export function useRealtimeChanges(listener: (tableIds: readonly string[] | null) => void): void {
  const conn = useContext(RealtimeContext);
  useEffect(() => conn?.onChanges(listener), [conn, listener]);
}
