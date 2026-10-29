import type { Workspace } from '@openrows/shared';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  BuildingIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  CreditCardIcon,
  GaugeIcon,
  PlusIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
} from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { useCreateRegionWorkspace, useCreateWorkspace, useRegions } from '../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  toast,
} from '../components/ui';
import { useWorkspaceList } from './useWorkspaceList';

/** The workspace in the URL (`/w/:workspaceId/...`), or undefined. */
export function useRouteWorkspaceId(): string | undefined {
  const path = useRouterState({ select: (s) => s.location.pathname });
  return path.match(/^\/w\/([^/]+)/)?.[1];
}

const LAST_WORKSPACE_KEY = 'openrows.workspace';

/** Remembers the workspace last opened (a `/w/:id` page or one of its bases) for Home. */
export function rememberWorkspace(id: string) {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, id);
  } catch {
    // Storage can be off (private mode); Home then falls back to the first workspace.
  }
}

function lastWorkspace(): string | null {
  try {
    return localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

/**
 * The selected workspace: the one in the URL, else the one last opened, else the first.
 * The sidebar's bases, the switcher and the Members link all follow it.
 */
export function useCurrentWorkspace(): Workspace | undefined {
  const workspaces = useWorkspaceList();
  const id = useRouteWorkspaceId();
  useEffect(() => {
    if (id) rememberWorkspace(id);
  }, [id]);
  const list = workspaces.data ?? [];
  const wanted = id ?? lastWorkspace();
  return list.find((w) => w.id === wanted) ?? list[0];
}

/** The sidebar's workspace switcher: pick a workspace, its members, or a new one. */
export function WorkspaceSwitcher() {
  const workspaces = useWorkspaceList();
  const current = useCurrentWorkspace();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  if (!current) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Workspace: ${current.name}`}
          className="mx-3 mb-2 flex h-9 items-center justify-between gap-2 rounded-sm border border-border bg-surface px-2.5 text-left hover:bg-hover"
        >
          <span className="truncate font-[550]">{current.name}</span>
          <ChevronsUpDownIcon className="size-4 shrink-0 text-text-2" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-60 overflow-y-auto"
        >
          {(workspaces.data ?? []).map((w) => (
            <DropdownMenuItem
              key={w.id}
              onSelect={() => navigate({ to: '/w/$workspaceId', params: { workspaceId: w.id } })}
            >
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {w.id === current.id && <CheckIcon className="!text-primary" aria-label="Current" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {current.role !== null && (
            <DropdownMenuItem
              onSelect={() =>
                navigate({ to: '/w/$workspaceId/members', params: { workspaceId: current.id } })
              }
            >
              <UsersIcon />
              Members
            </DropdownMenuItem>
          )}
          {current.role !== null && (
            <DropdownMenuItem
              onSelect={() =>
                navigate({ to: '/w/$workspaceId/usage', params: { workspaceId: current.id } })
              }
            >
              <GaugeIcon />
              Usage and plan
            </DropdownMenuItem>
          )}
          {current.role === 'owner' && (
            <DropdownMenuItem
              onSelect={() =>
                navigate({ to: '/w/$workspaceId/billing', params: { workspaceId: current.id } })
              }
            >
              <CreditCardIcon />
              Billing
            </DropdownMenuItem>
          )}
          {current.role === 'owner' && (
            <DropdownMenuItem
              onSelect={() =>
                navigate({ to: '/w/$workspaceId/ai', params: { workspaceId: current.id } })
              }
            >
              <SparklesIcon />
              AI
            </DropdownMenuItem>
          )}
          {current.role === 'owner' && (
            <DropdownMenuItem
              onSelect={() =>
                navigate({ to: '/w/$workspaceId/audit-log', params: { workspaceId: current.id } })
              }
            >
              <ScrollTextIcon />
              Audit log
            </DropdownMenuItem>
          )}
          {current.role === 'owner' && (
            <DropdownMenuItem
              onSelect={() =>
                navigate({ to: '/w/$workspaceId/admin', params: { workspaceId: current.id } })
              }
            >
              <BuildingIcon />
              Admin console
            </DropdownMenuItem>
          )}
          {current.role === 'owner' && (
            <DropdownMenuItem
              onSelect={() =>
                navigate({ to: '/w/$workspaceId/sso', params: { workspaceId: current.id } })
              }
            >
              <ShieldCheckIcon />
              Single sign-on
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <PlusIcon />
            New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

const selectClass =
  'h-8 rounded-sm border border-border bg-surface px-2 text-body hover:bg-hover disabled:opacity-60 pointer-coarse:h-[40px]';

/** A workspace URL the server answered, if it's in the region's app (never another origin). */
export function regionWorkspaceUrl(url: string, appUrl: string): string | null {
  try {
    const target = new URL(url);
    return target.origin === new URL(appUrl).origin ? target.href : null;
  } catch {
    return null;
  }
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState('');
  const create = useCreateWorkspace();
  const createElsewhere = useCreateRegionWorkspace();
  // Data residency: Enterprise owners pick the region; others never see the choice.
  const regions = useRegions(open);
  const [regionId, setRegionId] = useState<string | null>(null);
  const navigate = useNavigate();

  const current = regions.data?.current;
  const choice = regions.data?.createElsewhere ? (regionId ?? current) : current;
  const region = regions.data?.regions.find((r) => r.id === choice);
  const elsewhere = region !== undefined && region.id !== current;
  const pending = create.isPending || createElsewhere.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const onError = (err: unknown) =>
      toast.error(err instanceof ApiError ? err.message : "Couldn't create the workspace");
    if (elsewhere) {
      createElsewhere.mutate(
        { regionId: region.id, name: trimmed },
        {
          onSuccess: (ws) => {
            const url = regionWorkspaceUrl(ws.url, region.appUrl);
            if (!url) return onError(null);
            // The workspace lives in the other region's app: the same account signs in there.
            window.location.assign(url);
          },
          onError,
        }
      );
      return;
    }
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (ws) => {
          onOpenChange(false);
          setName('');
          void navigate({ to: '/w/$workspaceId', params: { workspaceId: ws.id } });
        },
        onError,
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              A workspace holds bases and the people who work on them.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor="new-workspace-name" className="text-small text-text-2">
              Name
            </label>
            <Input
              id="new-workspace-name"
              autoFocus
              value={name}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {regions.data?.createElsewhere && (
            <div className="grid gap-1.5">
              <label htmlFor="new-workspace-region" className="text-small text-text-2">
                Data region
              </label>
              <select
                id="new-workspace-region"
                value={choice}
                onChange={(e) => setRegionId(e.target.value)}
                aria-describedby="new-workspace-region-hint"
                className={selectClass}
              >
                {regions.data.regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <p id="new-workspace-region-hint" className="text-small text-text-2">
                Where its records, files and backups are stored. It can't be moved later.
                {elsewhere &&
                  ` The workspace opens in the ${region.name} app (${new URL(region.appUrl).host}).`}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? 'Creating…' : elsewhere ? `Create in ${region.name}` : 'Create workspace'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
