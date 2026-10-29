import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { Skeleton } from '../../components/ui';
import { when } from './model';

/**
 * Settings → "Support access": when support staff viewed the account as the user,
 * read-only, and why. Hidden while there is nothing to show.
 */
export function SupportAccess() {
  const list = useQuery({
    queryKey: queryKeys.supportAccess(),
    queryFn: () => api.me.supportAccess({ params: {} }),
  });
  if (list.isPending) return <Skeleton className="h-16 w-full" />;
  const entries = list.data?.entries ?? [];
  if (entries.length === 0) return null;
  return (
    <section
      aria-labelledby="settings-support-access"
      className="rounded-lg border border-border bg-surface p-5 shadow-1"
    >
      <h2 id="settings-support-access" className="text-heading font-semibold">
        Support access
      </h2>
      <p className="mt-1 text-text-2">
        Times our support team viewed your account as you, read-only, to help with a problem.
      </p>
      <ul className="mt-3 grid gap-2" data-testid="support-access">
        {entries.map((e) => (
          <li key={e.startedAt} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
            <p className="tabular-nums">
              {when(e.startedAt)} – {when(e.expiresAt)}
            </p>
            {e.reason && <p className="text-small text-text-2">{e.reason}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
