import { CloudOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Tooltip } from '../../components/ui';
import { cn } from '../../lib/utils';
import { useOffline } from '../offline/offline';
import type { ConnectionStatus as Status } from './connection';
import { useRealtimeStatus } from './RealtimeProvider';

const LABELS: Record<Status, { label: string; hint: string }> = {
  idle: { label: '', hint: '' },
  connecting: { label: 'Connecting…', hint: 'Connecting to live updates' },
  live: { label: 'Live', hint: 'Changes from collaborators appear as they happen' },
  reconnecting: { label: 'Reconnecting…', hint: 'Connection lost. Trying again' },
  offline: { label: 'Offline', hint: "You're offline. Live updates resume when you're back" },
};

/** The top bar's subtle live-updates indicator: a dot and, from 640 px, a word. */
export function ConnectionStatus() {
  const status = useRealtimeStatus();
  if (status === 'idle') return null;
  const { label, hint } = LABELS[status];
  return (
    <Tooltip content={hint}>
      <span
        role="status"
        data-testid="connection-status"
        data-status={status}
        aria-label={`Live updates: ${label.replace('…', '')}`}
        className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-small text-text-2"
      >
        <span
          aria-hidden
          className={cn(
            'size-2 rounded-full',
            status === 'live' && 'bg-primary',
            status === 'reconnecting' && 'bg-[var(--warning)]',
            (status === 'connecting' || status === 'offline') &&
              'border border-text-3 bg-transparent'
          )}
        />
        <span className="max-sm:sr-only">{label}</span>
      </span>
    </Tooltip>
  );
}

/** How long a lost connection waits before the banner shows (a quick reconnect shows none). */
export const BANNER_DELAY_MS = 3000;

/**
 * The "connection lost" banner under the top bar, when the socket has been down for a few
 * seconds after being live. Offline, the app's "offline, read-only" banner says it all.
 */
export function OfflineBanner() {
  const status = useRealtimeStatus();
  const offline = useOffline();
  const down = status === 'reconnecting' && !offline;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!down) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [down]);
  if (!down || !shown) return null;
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-header px-3 py-1.5 text-small text-text-2 md:px-6"
    >
      <CloudOff aria-hidden className="size-4 shrink-0 text-[var(--warning)]" />
      <span>Connection lost. Reconnecting… Changes from others will appear once it’s back.</span>
    </div>
  );
}
