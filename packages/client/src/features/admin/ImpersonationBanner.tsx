import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, toast } from '../../components/ui';
import { meQuery } from '../../lib/auth';
import { ADMIN_PATH, minutesLeft } from './model';

/**
 * The impersonating admin's banner, on every page: whose account this is, that it is
 * read-only, how long is left, and the way back to the console. When the time is up the app
 * reloads as the admin.
 */
export function ImpersonationBanner() {
  const me = useQuery(meQuery);
  const impersonation = me.data?.impersonation ?? null;
  const [now, setNow] = useState(Date.now);
  const queryClient = useQueryClient();
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    if (!impersonation) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [impersonation]);

  const left = impersonation ? minutesLeft(impersonation.expiresAt, now) : null;
  useEffect(() => {
    if (left === 0) window.location.assign(ADMIN_PATH);
  }, [left]);

  if (!impersonation || !me.data) return null;
  const who = me.data.user.email ?? me.data.user.name ?? 'this user';

  const stop = async () => {
    setEnding(true);
    try {
      await api.me.endImpersonation({ params: {} });
      queryClient.clear();
      window.location.assign(ADMIN_PATH);
    } catch {
      setEnding(false);
      toast.error("Couldn't end the impersonation");
    }
  };

  return (
    <div
      role="status"
      data-testid="impersonation-banner"
      className="flex shrink-0 items-center gap-2 border-b border-border border-t-2 border-t-warning bg-header px-3 py-2 md:px-6"
    >
      <EyeIcon aria-hidden className="size-4 shrink-0 text-[var(--warning)]" />
      <p className="min-w-0 flex-1">
        <span className="font-[550]">Viewing as {who}</span>
        <span className="text-text-2"> · read-only · {left} min left</span>
      </p>
      <Button size="sm" variant="secondary" onClick={stop} disabled={ending}>
        Stop impersonating
      </Button>
    </div>
  );
}
