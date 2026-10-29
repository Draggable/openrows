import type { MeResponse } from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import {
  DatabaseIcon,
  HomeIcon,
  SettingsIcon,
  ShieldIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { useState } from 'react';
import { baseQueries } from '../api/queries';
import { Skeleton } from '../components/ui';
import { API_DOCS_PATH } from '../features/api-docs/ApiDocsPage';
import { WorkspaceTrashDialog } from '../features/trash/TrashDialog';
import { Logo } from './Logo';
import { AccountRow, CommandHint, NavItem, SectionLabel } from './Shell';
import { useWorkspaceList } from './useWorkspaceList';
import { useCurrentWorkspace, WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * The sidebar outside a base: workspace, home, settings, the bases of the selected workspace
 * , the account.
 */
export function HomeSidebar({ me }: { me: MeResponse }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const workspaces = useWorkspaceList();
  const current = useCurrentWorkspace();
  const list = useQuery({ ...baseQueries.list(current?.id ?? ''), enabled: !!current });
  const bases = list.data?.bases ?? [];
  const loading = workspaces.isPending || (!!current && list.isPending);
  const [trashOpen, setTrashOpen] = useState(false);
  // The workspace's trash of bases is for its creators and owners.
  const canTrash = current?.role === 'owner' || current?.role === 'creator';

  return (
    <>
      <div className="flex h-[52px] items-center px-4">
        <Logo />
      </div>
      <WorkspaceSwitcher />
      <nav aria-label="Main" className="flex flex-col gap-0.5 py-1">
        <NavItem to="/" active={path === '/'} icon={<HomeIcon />}>
          Home
        </NavItem>
        {/* A base-only collaborator has no workspace role, so no members page. */}
        {current && current.role !== null && (
          <NavItem
            to="/w/$workspaceId/members"
            params={{ workspaceId: current.id }}
            active={path === `/w/${current.id}/members`}
            icon={<UsersIcon />}
          >
            Members
          </NavItem>
        )}
        <NavItem to="/settings" active={path === '/settings'} icon={<SettingsIcon />}>
          Settings
        </NavItem>
        {/* The hosted ops console: the server decides; this only hides the link. */}
        {me.user.isSystemAdmin && !me.impersonation && (
          <NavItem to="/admin" active={path === '/admin'} icon={<ShieldIcon />}>
            Ops console
          </NavItem>
        )}
        {canTrash && (
          <button
            type="button"
            onClick={() => setTrashOpen(true)}
            aria-haspopup="dialog"
            className="mx-2 flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-left text-body text-text hover:bg-hover pointer-coarse:h-[40px] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-2"
          >
            <Trash2Icon />
            <span className="truncate">Trash</span>
          </button>
        )}
      </nav>
      {canTrash && current && (
        <WorkspaceTrashDialog
          workspace={current}
          meId={me.user.id}
          open={trashOpen}
          onOpenChange={setTrashOpen}
        />
      )}
      <SectionLabel>Bases</SectionLabel>
      <nav aria-label="Bases" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-1">
        {loading ? (
          <div className="grid gap-2 px-4 py-1">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : bases.length === 0 ? (
          <p className="px-4 text-small text-text-2">
            {current ? 'No bases in this workspace yet' : 'No bases yet'}
            <br />
            Create a base to get started.
          </p>
        ) : (
          bases.map((b) => (
            <NavItem key={b.id} to="/b/$baseId" params={{ baseId: b.id }} icon={<DatabaseIcon />}>
              {b.name}
            </NavItem>
          ))
        )}
      </nav>
      <div className="px-4 pb-1 text-small">
        <a href={API_DOCS_PATH} className="text-text-2 hover:text-text">
          API docs
        </a>
      </div>
      <CommandHint />
      <AccountRow me={me} />
    </>
  );
}
