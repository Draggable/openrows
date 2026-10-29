import type { MeResponse } from '@openrows/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useWorkspace } from '../api/queries';
import { Skeleton } from '../components/ui';
import { BillingPanels } from '../features/usage/Billing';
import { HomeSidebar } from './HomeSidebar';
import { Shell, TopBar } from './Shell';

/**
 * `/w/:workspaceId/billing`, the workspace's billing settings, for its owners: the
 * subscription (plan, status, interval, seats, next renewal), invoices and the payment method in
 * the provider's portal, Cancel or Resume, and the plans to switch to or buy. Other members are
 * pointed to the Usage page.
 */
export function BillingPage({ me, workspaceId }: { me: MeResponse; workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  // Back from a checkout: the payment's confirmation is on its way.
  const [confirming] = useState(
    () => new URLSearchParams(window.location.search).get('checkout') === 'success'
  );
  const role = workspace.data?.role;
  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <TopBar>
        <h1 className="truncate text-heading font-semibold">
          {workspace.data ? `${workspace.data.name} · Billing` : 'Billing'}
        </h1>
      </TopBar>
      <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="grid max-w-xl grid-cols-[minmax(0,1fr)] gap-6">
          {!workspace.data ? (
            workspace.isError ? (
              <p role="alert" className="text-text-2">
                Couldn't load this workspace.
              </p>
            ) : (
              <Skeleton className="h-40" />
            )
          ) : role === 'owner' ? (
            <BillingPanels workspaceId={workspaceId} confirming={confirming} />
          ) : (
            <p className="text-text-2">
              Only the workspace's owners manage its billing.{' '}
              <Link
                to="/w/$workspaceId/usage"
                params={{ workspaceId }}
                className="text-primary underline-offset-2 hover:underline"
              >
                See the plan and usage
              </Link>
            </p>
          )}
        </div>
      </main>
    </Shell>
  );
}
