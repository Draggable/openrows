import type { MeResponse } from '@openrows/shared';
import { useWorkspace } from '../api/queries';
import { Skeleton } from '../components/ui';
import { ScimSettings } from '../features/scim/ScimSettings';
import { SsoSettings } from '../features/sso/SsoSettings';
import { HomeSidebar } from './HomeSidebar';
import { Shell, TopBar } from './Shell';

/**
 * `/w/:workspaceId/sso`, the workspace's single sign-on, for its owners: the identity
 * provider, its email domains, "require SSO" and JIT membership (hosted Business and Enterprise),
 * and SCIM provisioning.
 */
export function SsoPage({ me, workspaceId }: { me: MeResponse; workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const role = workspace.data?.role;
  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <TopBar>
        <h1 className="truncate text-heading font-semibold">
          {workspace.data ? `${workspace.data.name} · Single sign-on` : 'Single sign-on'}
        </h1>
      </TopBar>
      <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
          {!workspace.data ? (
            workspace.isError ? (
              <p role="alert" className="text-text-2">
                Couldn't load this workspace.
              </p>
            ) : (
              <Skeleton className="h-40" />
            )
          ) : role === 'owner' ? (
            <>
              <SsoSettings workspaceId={workspaceId} />
              <ScimSettings workspaceId={workspaceId} />
            </>
          ) : (
            <p className="text-text-2">Only the workspace's owners manage its single sign-on.</p>
          )}
        </div>
      </main>
    </Shell>
  );
}
