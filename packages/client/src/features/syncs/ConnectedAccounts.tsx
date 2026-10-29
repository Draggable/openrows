import type { SyncConnectorInfo } from '@openrows/shared';
import { LinkIcon } from 'lucide-react';
import { ApiError } from '../../api/client';
import { useDisconnectConnector, useSyncConnectors } from '../../api/queries';
import { Button, toast } from '../../components/ui';
import { connectUrl } from './ConnectorPicker';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/**
 * Settings → Connected accounts: your accounts at the instance's sync connectors (the
 * hosted service's Google Sheets). Connect one, or disconnect it: OpenRows revokes its access at
 * the provider and the syncs you created from it pause until someone resumes them. Hidden when
 * the instance has no connectors.
 */
export function ConnectedAccounts() {
  const list = useSyncConnectors();
  const disconnect = useDisconnectConnector();
  if (!list.data?.length) return null;

  const onDisconnect = (c: SyncConnectorInfo) => {
    if (
      !window.confirm(
        `Disconnect ${c.name}? Syncs you created from it pause until someone resumes them.`
      )
    ) {
      return;
    }
    disconnect.mutate(c.id, {
      onSuccess: () => toast.success(`${c.name} disconnected`),
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : `Couldn't disconnect ${c.name}`),
    });
  };

  return (
    <section
      aria-labelledby="settings-connected-accounts"
      className="rounded-lg border border-border bg-surface p-5 shadow-1"
    >
      <h2 id="settings-connected-accounts" className="text-heading font-semibold">
        Connected accounts
      </h2>
      <p className="mt-1 text-text-2">
        Accounts OpenRows reads from for synced tables. OpenRows only reads, with your access.
      </p>
      <ul aria-label="Connected accounts" className="mt-4 flex flex-col divide-y divide-border">
        {list.data.map((c) => (
          <li key={c.id} className="flex items-center gap-3 py-2">
            <LinkIcon className="size-4 shrink-0 text-text-2" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="font-[550]">{c.name}</div>
              <div className="text-small text-text-2 [overflow-wrap:anywhere]">
                {c.account
                  ? `${c.account.label} · connected ${day(c.account.connectedAt)}`
                  : 'Not connected'}
              </div>
            </div>
            {c.account ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disconnect.isPending}
                onClick={() => onDisconnect(c)}
                aria-label={`Disconnect ${c.name}`}
              >
                Disconnect
              </Button>
            ) : (
              <Button size="sm" variant="outline" asChild>
                <a href={connectUrl(c.id, `${location.pathname}${location.search}`)}>Connect</a>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
