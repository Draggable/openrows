import { type MeResponse, roleAllows, type ViewMeta } from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  CodeIcon,
  EllipsisIcon,
  LayoutDashboardIcon,
  PuzzleIcon,
  SparklesIcon,
  UserPlusIcon,
  ZapIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { baseQueries, tableQueries, useAiAvailability, viewQueries } from '../api/queries';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
  Tooltip,
} from '../components/ui';
import { BaseAssistantDialog } from '../features/assistant/AssistantDialog';
import { CollaboratorsProvider } from '../features/collaborators/context';
import { ShareBaseDialog } from '../features/collaborators/ShareBaseDialog';
import { ExtensionsPanel } from '../features/extensions/ExtensionsPanel';
import { Grid } from '../features/grid/Grid';
import { useOffline } from '../features/offline/offline';
import { ConnectionStatus, OfflineBanner } from '../features/realtime/ConnectionStatus';
import { PresenceAvatars, PresenceProvider, usePresence } from '../features/realtime/Presence';
import { useRealtimeSubscription } from '../features/realtime/RealtimeProvider';
import { SyncBar } from '../features/syncs/SyncBar';
import { BasePaymentBanner } from '../features/usage/PaymentBanner';
import { BaseUsageBanner } from '../features/usage/UsageBanner';
import { Calendar } from '../features/views/calendar/Calendar';
import { FormView } from '../features/views/form/FormView';
import { Gallery } from '../features/views/gallery/Gallery';
import { Kanban } from '../features/views/kanban/Kanban';
import { List } from '../features/views/list/List';
import { Timeline } from '../features/views/timeline/Timeline';
import { cn } from '../lib/utils';
import { BaseSidebar } from './BaseSidebar';
import { Shell, TopBar } from './Shell';
import { rememberWorkspace } from './WorkspaceSwitcher';

/** The screens of the gallery, timeline and list views and the form builder. */
const VIEWS: Partial<Record<ViewMeta['type'], typeof Gallery>> = {
  gallery: Gallery,
  timeline: Timeline,
  list: List,
  form: FormView,
};

/**
 * `/b/:baseId/:tableId/:viewId`: the base sidebar, the breadcrumb and the view. `?record=<id>`
 * opens that record's expand view.
 */
export function BasePage({
  me,
  baseId,
  tableId,
  viewId,
  recordId,
}: {
  me: MeResponse;
  baseId: string;
  tableId: string;
  viewId: string;
  recordId?: string | undefined;
}) {
  const navigate = useNavigate();
  const onExpandRecord = useCallback(
    (record: string | null) =>
      navigate({
        to: '/b/$baseId/$tableId/$viewId',
        params: { baseId, tableId, viewId },
        search: record ? { record } : {},
        replace: true,
      }),
    [navigate, baseId, tableId, viewId]
  );
  const baseQuery = useQuery(baseQueries.detail(baseId));
  // Offline the base is read-only: the views show the service worker's cached copy.
  const offline = useOffline();
  const base = useMemo(
    () => ({
      data:
        offline && baseQuery.data
          ? { ...baseQuery.data, role: 'read_only' as const }
          : baseQuery.data,
    }),
    [offline, baseQuery.data]
  );
  const tables = useQuery(tableQueries.list(baseId));
  const table = useQuery(tableQueries.detail(tableId));
  const views = useQuery(viewQueries.list(tableId));
  const view = views.data?.views.find((v) => v.id === viewId);
  // Live updates: the open table's records, fields and views, and the base's structure.
  useRealtimeSubscription({ tableId });
  // Presence travels on the view's subscription: who else is on this view.
  useRealtimeSubscription({ viewId });
  // Home's sidebar then shows this base's workspace.
  const workspaceId = base.data?.workspaceId;
  const [sharing, setSharing] = useState(false);
  const canShare = !!base.data && roleAllows(base.data.role, 'base:manage_members');
  const canAutomate = !!base.data && roleAllows(base.data.role, 'base:manage_automations');
  const canScript = !!base.data && roleAllows(base.data.role, 'base:read_scripts');
  // The AI assistant: creators, when the workspace has an AI provider.
  const [assisting, setAssisting] = useState(false);
  const aiOn = useAiAvailability(workspaceId).data?.available === true;
  const canAssist = aiOn && !!base.data && roleAllows(base.data.role, 'base:ai_assistant');
  useEffect(() => {
    if (workspaceId) rememberWorkspace(workspaceId);
  }, [workspaceId]);
  // The extension panel, open or closed per browser.
  const [extensionsOpen, setExtensionsOpen] = useState(storedExtensionsOpen);
  const toggleExtensions = useCallback((open: boolean) => {
    setExtensionsOpen(open);
    try {
      if (open) localStorage.setItem(EXTENSIONS_OPEN_KEY, '1');
      else localStorage.removeItem(EXTENSIONS_OPEN_KEY);
    } catch {
      // Private mode: the choice lasts for the page.
    }
  }, []);

  return (
    <CollaboratorsProvider workspaceId={base.data?.workspaceId} meId={me.user.id}>
      <Shell
        sidebar={
          <BaseSidebar
            me={me}
            base={base.data}
            tables={tables.data?.tables}
            views={views.data?.views}
            sections={views.data?.sections}
            tableId={tableId}
            viewId={viewId}
          />
        }
      >
        <PresenceProvider viewId={viewId}>
          <ExpandedPresence recordId={recordId} />
          <TopBar
            actions={
              <>
                <PresenceAvatars />
                <ConnectionStatus />
                {/* Phones get one "More" menu for the base's pages, so the view's name keeps
                    its room in the top bar. Narrower than 1152 px, the secondary actions
                    show their icons only, with a tooltip, so the breadcrumb stays readable at
                    1280 px. */}
                <Tooltip content="Interfaces">
                  <Button variant="ghost" asChild className={SECONDARY_ACTION}>
                    <Link to="/b/$baseId/interfaces" params={{ baseId }} search={{}}>
                      <LayoutDashboardIcon />
                      <span className={COLLAPSIBLE_LABEL}>Interfaces</span>
                    </Link>
                  </Button>
                </Tooltip>
                {canAssist && (
                  <Tooltip content="Assistant">
                    <Button
                      variant="ghost"
                      onClick={() => setAssisting(true)}
                      aria-haspopup="dialog"
                      className="@max-[1152px]/topbar:px-2"
                    >
                      <SparklesIcon />
                      <span className={cn(COLLAPSIBLE_LABEL, 'max-sm:sr-only')}>Assistant</span>
                    </Button>
                  </Tooltip>
                )}
                {canAutomate && (
                  <Tooltip content="Automations">
                    <Button variant="ghost" asChild className={SECONDARY_ACTION}>
                      <Link to="/b/$baseId/automations" params={{ baseId }} search={{}}>
                        <ZapIcon />
                        <span className={COLLAPSIBLE_LABEL}>Automations</span>
                      </Link>
                    </Button>
                  </Tooltip>
                )}
                {canScript && (
                  <Tooltip content="Scripts">
                    <Button variant="ghost" asChild className={SECONDARY_ACTION}>
                      <Link to="/b/$baseId/scripts" params={{ baseId }} search={{}}>
                        <CodeIcon />
                        <span className={COLLAPSIBLE_LABEL}>Scripts</span>
                      </Link>
                    </Button>
                  </Tooltip>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="More" className="sm:hidden">
                      <EllipsisIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem asChild>
                      <Link to="/b/$baseId/interfaces" params={{ baseId }} search={{}}>
                        <LayoutDashboardIcon />
                        Interfaces
                      </Link>
                    </DropdownMenuItem>
                    {canAutomate && (
                      <DropdownMenuItem asChild>
                        <Link to="/b/$baseId/automations" params={{ baseId }} search={{}}>
                          <ZapIcon />
                          Automations
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {canScript && (
                      <DropdownMenuItem asChild>
                        <Link to="/b/$baseId/scripts" params={{ baseId }} search={{}}>
                          <CodeIcon />
                          Scripts
                        </Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => toggleExtensions(!extensionsOpen)}>
                      <PuzzleIcon />
                      {extensionsOpen ? 'Hide extensions' : 'Extensions'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Tooltip content={extensionsOpen ? 'Hide extensions' : 'Extensions'}>
                  <Button
                    variant="ghost"
                    aria-pressed={extensionsOpen}
                    onClick={() => toggleExtensions(!extensionsOpen)}
                    className={SECONDARY_ACTION}
                  >
                    <PuzzleIcon />
                    <span className={COLLAPSIBLE_LABEL}>Extensions</span>
                  </Button>
                </Tooltip>
                {canShare && (
                  <Button onClick={() => setSharing(true)} aria-haspopup="dialog">
                    <UserPlusIcon />
                    <span className="max-sm:sr-only">Share</span>
                  </Button>
                )}
              </>
            }
          >
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-[15px]">
              {/* Phones show Table / View only; the drawer names the base. */}
              {/* The base's name gives way first, then the table's, then the view's. */}
              <Link
                to="/b/$baseId"
                params={{ baseId }}
                className="min-w-6 shrink-[8] truncate text-text-2 hover:text-text max-sm:hidden"
              >
                {base.data?.name ?? <Skeleton className="h-4 w-24" />}
              </Link>
              <span className="text-text-3 max-sm:hidden">/</span>
              <span className="min-w-6 shrink-[4] truncate text-text-2">
                {table.data?.name ?? <Skeleton className="h-4 w-20" />}
              </span>
              <span className="text-text-3">/</span>
              <h1 className="min-w-6 truncate font-[550]" aria-current="page">
                {view?.name ?? <Skeleton className="h-4 w-20" />}
              </h1>
            </nav>
          </TopBar>
          <OfflineBanner />
          <BasePaymentBanner base={base.data} />
          <BaseUsageBanner base={base.data} />
          {table.data?.synced && <SyncBar table={table.data} role={base.data?.role} />}
          {canAssist && (
            <BaseAssistantDialog baseId={baseId} open={assisting} onOpenChange={setAssisting} />
          )}
          {canShare && base.data && (
            <ShareBaseDialog
              base={base.data}
              meId={me.user.id}
              open={sharing}
              onOpenChange={setSharing}
            />
          )}
          <div className="relative flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {table.data && view && VIEWS[view.type] ? (
                (() => {
                  const View = VIEWS[view.type];
                  return View ? (
                    <View
                      key={viewId}
                      table={table.data}
                      view={view}
                      viewId={viewId}
                      role={base.data?.role}
                      expandedRecordId={recordId}
                      onExpandRecord={onExpandRecord}
                    />
                  ) : null;
                })()
              ) : table.data && view?.type === 'calendar' ? (
                <Calendar
                  key={viewId}
                  table={table.data}
                  view={view}
                  viewId={viewId}
                  role={base.data?.role}
                  expandedRecordId={recordId}
                  onExpandRecord={onExpandRecord}
                />
              ) : table.data && view?.type === 'kanban' ? (
                <Kanban
                  key={viewId}
                  table={table.data}
                  view={view}
                  viewId={viewId}
                  role={base.data?.role}
                  expandedRecordId={recordId}
                  onExpandRecord={onExpandRecord}
                />
              ) : table.data ? (
                <Grid
                  key={viewId}
                  table={table.data}
                  view={view}
                  viewId={viewId}
                  role={base.data?.role}
                  expandedRecordId={recordId}
                  onExpandRecord={onExpandRecord}
                />
              ) : (
                <div className="grid gap-2 p-4" aria-busy="true">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-7" />
                  ))}
                </div>
              )}
            </div>
            {extensionsOpen && base.data && (
              <ExtensionsPanel
                base={base.data}
                tableId={tableId}
                viewId={viewId}
                expandedRecordId={recordId}
                onClose={() => toggleExtensions(false)}
              />
            )}
          </div>
        </PresenceProvider>
      </Shell>
    </CollaboratorsProvider>
  );
}

/** The top bar's secondary actions: hidden on phones (the "More" menu), icon-only when narrow. */
const SECONDARY_ACTION = 'max-sm:hidden @max-[1152px]/topbar:px-2';
/** A label that collapses to the button's accessible name when the top bar is narrow. */
const COLLAPSIBLE_LABEL = '@max-[1152px]/topbar:sr-only';

const EXTENSIONS_OPEN_KEY = 'openrows-extensions-open';

function storedExtensionsOpen(): boolean {
  try {
    return localStorage.getItem(EXTENSIONS_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shares the record open in the expand view (`?record=`) with the others on the view. */
function ExpandedPresence({ recordId }: { recordId: string | undefined }) {
  const { update } = usePresence();
  useEffect(() => {
    // `?record=` comes from the URL: only a record id is shared.
    update({ expandedRecordId: recordId && UUID.test(recordId) ? recordId : null });
  }, [update, recordId]);
  return null;
}
