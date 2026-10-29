import type { Base, MeResponse, Workspace } from '@openrows/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  CloudDownloadIcon,
  DatabaseIcon,
  FileUpIcon,
  LayoutTemplateIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Table2Icon,
  Trash2Icon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import {
  baseQueries,
  templateQueries,
  useAiAvailability,
  useSharedInterfaces,
} from '../api/queries';
import { Button, Skeleton } from '../components/ui';
import { AirtableImportDialog } from '../features/airtable/AirtableImportDialog';
import { DescribeBaseDialog } from '../features/assistant/AssistantDialog';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { TemplateGallery, TemplateTile } from '../features/templates/TemplateGallery';
import { WorkspaceTrashDialog } from '../features/trash/TrashDialog';
import { PaymentBanner } from '../features/usage/PaymentBanner';
import { WorkspaceUsageBanner } from '../features/usage/UsageBanner';
import { useAppActions } from './AppContext';
import { HelpMenu } from './HelpMenu';
import { HomeSidebar } from './HomeSidebar';
import { greeting } from './names';
import { NavToggle, Shell } from './Shell';
import { useCreateBaseFlow } from './useCreateBaseFlow';
import { useWorkspaceList } from './useWorkspaceList';
import { useCurrentWorkspace } from './WorkspaceSwitcher';

/**
 * Home (`/`) and a workspace (`/w/:workspaceId`): the greeting, "Start from scratch", "Import a
 * file" (a new base from a CSV), "Import from Airtable", "Start from a template"
 * (a few template tiles and the gallery; `?template=<slug>` opens one's preview), and the
 * bases grid per workspace. A new user sees the
 * empty state with "Create a base". New bases go into the selected workspace when the user can
 * create bases there, else the first one they can.
 */
export function HomePage({
  me,
  workspaceId,
  template,
}: {
  me: MeResponse;
  workspaceId?: string;
  /** A template to preview at once (links from openrows.io/templates). */
  template?: string | undefined;
}) {
  const navigate = useNavigate();
  const [galleryOpen, setGalleryOpen] = useState(template !== undefined);
  const [gallerySlug, setGallerySlug] = useState(template);
  const templates = useQuery(templateQueries.list());
  const openGallery = (slug?: string) => {
    setGallerySlug(slug);
    setGalleryOpen(true);
  };
  const { openCreateBase: openDialog, openPalette } = useAppActions();
  const workspaces = useWorkspaceList();
  const current = useCurrentWorkspace();
  const target =
    current && (current.role === 'owner' || current.role === 'creator') ? current.id : undefined;
  const openCreateBase = (id?: string) => openDialog(id ?? target);
  const importBase = useCreateBaseFlow(me);
  const fileInput = useRef<HTMLInputElement>(null);
  const [airtableOpen, setAirtableOpen] = useState(false);
  // Airtable imports go into a workspace where the user creates bases.
  const airtableTarget =
    target ?? workspaces.data?.find((w) => w.role === 'owner' || w.role === 'creator')?.id;
  // "Describe it": a new base drafted by the AI assistant, where AI is on.
  const [describing, setDescribing] = useState(false);
  const describeOn = useAiAvailability(airtableTarget).data?.available === true;
  const shown = (workspaces.data ?? []).filter((w) => !workspaceId || w.id === workspaceId);
  const lists = useQueries({ queries: shown.map((w) => baseQueries.list(w.id)) });
  const loading = workspaces.isPending || lists.some((q) => q.isPending);
  const total = lists.reduce((n, q) => n + (q.data?.bases.length ?? 0), 0);
  const firstName = me.user.name?.split(' ')[0];

  return (
    <Shell sidebar={<HomeSidebar me={me} />}>
      <header className="flex h-[52px] shrink-0 items-center gap-2 px-3 pt-4 md:px-8">
        <NavToggle />
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={openPalette}
            className="justify-start text-text-2 sm:w-64"
          >
            <SearchIcon />
            <span className="flex-1 text-left font-normal max-sm:sr-only">Search bases</span>
            <kbd className="rounded-xs border border-border px-1.5 font-sans text-small font-normal max-sm:hidden pointer-coarse:hidden">
              Ctrl K
            </kbd>
          </Button>
          <Button onClick={() => openCreateBase(workspaceId)}>
            <PlusIcon />
            New base
          </Button>
          <HelpMenu />
          <NotificationBell />
        </div>
      </header>
      {current && <PaymentBanner workspaceId={current.id} role={current.role} />}
      {current && <WorkspaceUsageBanner workspaceId={current.id} role={current.role} />}
      <main className="flex-1 overflow-y-auto px-4 pt-4 pb-12 md:px-8">
        <div className="mx-auto max-w-[1200px]">
          <h1 className="text-display font-[650] tracking-[-0.01em]">
            {greeting()}
            {firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-1 text-[15px] text-text-2">
            Start a base from scratch or a file.
            <span className="pointer-coarse:hidden">
              {' '}
              Everything is keyboard-first: press Ctrl K anytime.
            </span>
          </p>

          <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <button
              type="button"
              onClick={() => openCreateBase(workspaceId)}
              className="flex items-center gap-4 rounded-lg border border-border border-t-[3px] border-t-brand bg-surface p-5 text-left shadow-1 hover:bg-hover"
            >
              <span className="flex size-12 items-center justify-center rounded-md bg-selected text-primary">
                <Table2Icon className="size-6" />
              </span>
              <span>
                <span className="block text-heading font-semibold">Start from scratch</span>
                <span className="block text-text-2">Empty base with one table</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={importBase.isPending}
              aria-busy={importBase.isPending || undefined}
              className="flex items-center gap-4 rounded-lg border border-border bg-surface p-5 text-left shadow-1 hover:bg-hover disabled:opacity-70"
            >
              <span className="flex size-12 items-center justify-center rounded-md bg-hover text-text-2">
                <FileUpIcon className="size-6" />
              </span>
              <span>
                <span className="block text-heading font-semibold">
                  {importBase.isPending ? 'Creating the base…' : 'Import a file'}
                </span>
                <span className="block text-text-2">New base from a CSV, up to 50 MB</span>
                <span className="block text-small text-text-2">Excel is coming soon</span>
              </span>
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
              aria-label="CSV file for a new base"
              tabIndex={-1}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) importBase.mutate({ file, workspaceId: target });
              }}
            />
            <button
              type="button"
              onClick={() => openGallery()}
              aria-haspopup="dialog"
              className="flex items-center gap-4 rounded-lg border border-border bg-surface p-5 text-left shadow-1 hover:bg-hover"
            >
              <span className="flex size-12 items-center justify-center rounded-md bg-hover text-text-2">
                <LayoutTemplateIcon className="size-6" />
              </span>
              <span>
                <span className="block text-heading font-semibold">Start from a template</span>
                <span className="block text-text-2">CRM, roadmap, bug tracker and more</span>
              </span>
            </button>
            {airtableTarget && describeOn && (
              <>
                <button
                  type="button"
                  onClick={() => setDescribing(true)}
                  aria-haspopup="dialog"
                  className="flex items-center gap-4 rounded-lg border border-border bg-surface p-5 text-left shadow-1 hover:bg-hover"
                >
                  <span className="flex size-12 items-center justify-center rounded-md bg-hover text-text-2">
                    <SparklesIcon className="size-6" />
                  </span>
                  <span>
                    <span className="block text-heading font-semibold">Describe it</span>
                    <span className="block text-text-2">
                      Type what you want to track and the assistant drafts the tables
                    </span>
                  </span>
                </button>
                <DescribeBaseDialog
                  workspaceId={airtableTarget}
                  open={describing}
                  onOpenChange={setDescribing}
                />
              </>
            )}
            {airtableTarget && (
              <>
                <button
                  type="button"
                  onClick={() => setAirtableOpen(true)}
                  aria-haspopup="dialog"
                  className="flex items-center gap-4 rounded-lg border border-border bg-surface p-5 text-left shadow-1 hover:bg-hover"
                >
                  <span className="flex size-12 items-center justify-center rounded-md bg-hover text-text-2">
                    <CloudDownloadIcon className="size-6" />
                  </span>
                  <span>
                    <span className="block text-heading font-semibold">Import from Airtable</span>
                    <span className="block text-text-2">
                      Tables, fields and records with a token
                    </span>
                  </span>
                </button>
                <AirtableImportDialog
                  workspaceId={airtableTarget}
                  open={airtableOpen}
                  onOpenChange={setAirtableOpen}
                />
              </>
            )}
          </div>

          <TemplateGallery
            me={me}
            open={galleryOpen}
            onOpenChange={(open) => {
              setGalleryOpen(open);
              // The link's ?template= has done its job once the gallery closes.
              if (!open && template) void navigate({ to: '.', search: {}, replace: true });
            }}
            workspaceId={target}
            initialSlug={gallerySlug}
          />
          <SharedInterfaces />
          {(templates.data?.templates.length ?? 0) > 0 && (
            <section aria-labelledby="home-templates" className="mt-8">
              <div className="mb-3 flex items-center gap-2">
                <h2 id="home-templates" className="text-heading font-semibold">
                  Templates
                </h2>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => openGallery()}>
                  Browse all templates
                </Button>
              </div>
              <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {templates.data?.templates.slice(0, 4).map((t) => (
                  <li key={t.slug}>
                    <TemplateTile template={t} onSelect={() => openGallery(t.slug)} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {loading ? (
            <section aria-busy="true" aria-label="Loading bases" className="mt-10">
              <Skeleton className="mb-4 h-6 w-40" />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-24 rounded-lg" />
                ))}
              </div>
            </section>
          ) : total === 0 ? (
            <EmptyState onCreate={() => openCreateBase(workspaceId)} />
          ) : (
            shown.map((w, i) => (
              <WorkspaceBases
                key={w.id}
                workspace={w}
                meId={me.user.id}
                bases={lists[i]?.data?.bases ?? []}
              />
            ))
          )}
        </div>
      </main>
    </Shell>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="mt-10 flex flex-col items-center rounded-lg border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-md bg-selected text-primary">
        <DatabaseIcon className="size-6" />
      </span>
      <h2 className="mt-4 text-heading font-semibold">No bases yet</h2>
      <p className="mt-1 max-w-sm text-text-2">
        A base holds your tables, like a spreadsheet that knows what each column is.
      </p>
      <Button className="mt-5" size="lg" onClick={onCreate}>
        <PlusIcon />
        Create a base
      </Button>
    </section>
  );
}

function WorkspaceBases({
  workspace,
  meId,
  bases,
}: {
  workspace: Workspace;
  meId: string;
  bases: Base[];
}) {
  const { openCreateBase } = useAppActions();
  const canCreate = workspace.role === 'owner' || workspace.role === 'creator';
  const [trashOpen, setTrashOpen] = useState(false);
  return (
    <section className="mt-10" aria-labelledby={`ws-${workspace.id}`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 id={`ws-${workspace.id}`} className="text-title font-semibold">
          <Link
            to="/w/$workspaceId"
            params={{ workspaceId: workspace.id }}
            className="hover:underline"
          >
            {workspace.name}
          </Link>
        </h2>
        {/* Base-only collaborators see the bases they were invited to, nothing else. */}
        {workspace.role === null && (
          <span className="text-small text-text-2">Bases shared with you</span>
        )}
        {canCreate && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTrashOpen(true)}
              aria-haspopup="dialog"
              aria-label={`Trash of ${workspace.name}`}
            >
              <Trash2Icon />
              <span className="max-sm:sr-only">Trash</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openCreateBase(workspace.id)}>
              <PlusIcon />
              New base
            </Button>
          </div>
        )}
      </div>
      {canCreate && (
        <WorkspaceTrashDialog
          workspace={workspace}
          meId={meId}
          open={trashOpen}
          onOpenChange={setTrashOpen}
        />
      )}
      {bases.length === 0 ? (
        <p className="text-text-2">No bases in this workspace yet.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {bases.map((b) => (
            <li key={b.id}>
              <Link
                to="/b/$baseId"
                params={{ baseId: b.id }}
                className="flex h-full items-start gap-3 rounded-lg border border-border bg-surface p-4 shadow-1 hover:bg-hover"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-selected text-primary">
                  <DatabaseIcon className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-[550]">{b.name}</span>
                  <span className="block truncate text-small text-text-2">
                    {b.description ?? `Updated ${new Date(b.updatedAt).toLocaleDateString()}`}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Interfaces shared with you alone, without their bases. */
function SharedInterfaces() {
  const shared = useSharedInterfaces();
  const list = shared.data?.interfaces ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="home-shared-interfaces" className="mt-8">
      <h2 id="home-shared-interfaces" className="mb-3 text-heading font-semibold">
        Interfaces shared with you
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((i) => (
          <li key={i.id}>
            <Link
              to="/i/$interfaceId"
              params={{ interfaceId: i.id }}
              className="flex flex-col gap-0.5 rounded-md border border-border bg-surface px-4 py-3 shadow-1 hover:border-border-strong"
            >
              <span className="truncate font-[550] text-text">{i.name}</span>
              <span className="truncate text-small text-text-2">
                {i.baseName} · {i.workspaceName}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
