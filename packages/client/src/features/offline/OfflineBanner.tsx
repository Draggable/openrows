import { CloudOff } from 'lucide-react';
import { useOffline } from './offline';

/**
 * The "offline, read-only" banner at the top of every signed-in page: neutral surface,
 * the icon in the warning colour, like the realtime banner it replaces while offline.
 */
export function OfflineBanner() {
  const offline = useOffline();
  if (!offline) return null;
  return (
    <div
      role="status"
      data-testid="app-offline-banner"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-header px-3 py-1.5 text-small text-text-2 md:px-6"
    >
      <CloudOff aria-hidden className="size-4 shrink-0 text-[var(--warning)]" />
      <span>
        <span className="font-[550] text-text">Offline, read-only.</span> You're seeing what you
        last viewed. Editing comes back when you're online.
      </span>
    </div>
  );
}
