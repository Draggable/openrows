import type { MeResponse } from '@openrows/shared';
import { useWorkspace } from '../api/queries';
import { Skeleton } from '../components/ui';
import { AuditLogPanels } from '../features/audit/AuditLog';
import { HomeSidebar } from './HomeSidebar';
import { Shell, TopBar } from './Shell';

/**
 * `/w/:workspaceId/audit-log`, the workspace's audit log, for its owners: entries with
 * filters, exports and the SIEM stream (hosted Enterprise plan).
 */
export function AuditLogPage({ me, workspaceId }: { me: MeResponse; workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const role = workspace.data?.role;
  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <TopBar>
        <h1 className="truncate text-heading font-semibold">
          {workspace.data ? `${workspace.data.name} · Audit log` : 'Audit log'}
        </h1>
      </TopBar>
      <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
        <div className="grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-6">
          {!workspace.data ? (
            workspace.isError ? (
              <p role="alert" className="text-text-2">
                Couldn't load this workspace.
              </p>
            ) : (
              <Skeleton className="h-40" />
            )
          ) : role === 'owner' ? (
            <AuditLogPanels workspaceId={workspaceId} />
          ) : (
            <p className="text-text-2">Only the workspace's owners see its audit log.</p>
          )}
        </div>
      </main>
    </Shell>
  );
}
