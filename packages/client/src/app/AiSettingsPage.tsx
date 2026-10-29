import type { MeResponse } from '@openrows/shared';
import { useWorkspace } from '../api/queries';
import { Skeleton } from '../components/ui';
import { AiSettingsPanels } from '../features/ai/AiSettings';
import { HomeSidebar } from './HomeSidebar';
import { Shell, TopBar } from './Shell';

/**
 * `/w/:workspaceId/ai`, the workspace's AI settings, for its owners: the provider AI
 * features use and the workspace's own API key.
 */
export function AiSettingsPage({ me, workspaceId }: { me: MeResponse; workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const role = workspace.data?.role;
  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <TopBar>
        <h1 className="truncate text-heading font-semibold">
          {workspace.data ? `${workspace.data.name} · AI` : 'AI'}
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
            <AiSettingsPanels workspaceId={workspaceId} />
          ) : (
            <p className="text-text-2">Only the workspace's owners manage its AI settings.</p>
          )}
        </div>
      </main>
    </Shell>
  );
}
