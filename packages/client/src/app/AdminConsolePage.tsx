import type { MeResponse } from '@openrows/shared';
import { useWorkspace } from '../api/queries';
import { Skeleton } from '../components/ui';
import { AdminConsole } from '../features/admin-console/AdminConsole';
import { HomeSidebar } from './HomeSidebar';
import { Shell, TopBar } from './Shell';

/**
 * `/w/:workspaceId/admin`, the workspace's admin console, for its owners: policies,
 * single sign-on and SCIM at a glance, and everyone with access (hosted Enterprise).
 */
export function AdminConsolePage({ me, workspaceId }: { me: MeResponse; workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const role = workspace.data?.role;
  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <TopBar>
        <h1 className="truncate text-heading font-semibold">
          {workspace.data ? `${workspace.data.name} · Admin console` : 'Admin console'}
        </h1>
      </TopBar>
      <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="grid max-w-4xl grid-cols-[minmax(0,1fr)] gap-6">
          {!workspace.data ? (
            workspace.isError ? (
              <p role="alert" className="text-text-2">
                Couldn't load this workspace.
              </p>
            ) : (
              <Skeleton className="h-40" />
            )
          ) : role === 'owner' ? (
            <AdminConsole workspaceId={workspaceId} />
          ) : (
            <p className="text-text-2">Only the workspace's owners use its admin console.</p>
          )}
        </div>
      </main>
    </Shell>
  );
}
