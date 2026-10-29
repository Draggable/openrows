import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  ActivityIcon,
  BookOpenIcon,
  CheckIcon,
  DatabaseIcon,
  HomeIcon,
  LayoutListIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  Table2Icon,
  UserRoundIcon,
} from 'lucide-react';
import { useState } from 'react';
import { baseQueries, tableQueries, workspaceQueries } from '../api/queries';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../components/ui';
import { signInInfoQuery } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { useAppActions } from './AppContext';
import { useCreateViewAction, VIEW_TYPE_OPTIONS, ViewTypeIcon } from './CreateView';
import { DOCS_URL } from './HelpMenu';

/**
 * Ctrl/⌘ K: jump to a base or a table of the open base, or run a command. "Create view…" (on
 * a table, for editors and up) turns the list into the view types; Backspace in the empty
 * search goes back.
 */
export function CommandPalette({
  open,
  onOpenChange: setOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [page, setPage] = useState<'root' | 'create-view'>('root');
  const [search, setSearch] = useState('');
  const [personal, setPersonal] = useState(false);
  const onOpenChange = (next: boolean) => {
    if (!next) {
      setPage('root');
      setSearch('');
      setPersonal(false);
    }
    setOpen(next);
  };
  const navigate = useNavigate();
  const { openCreateBase } = useAppActions();
  const { toggle, resolved } = useTheme();
  const statusPageUrl = useQuery(signInInfoQuery).data?.statusPageUrl ?? null;
  const { baseId, tableId } = useParams({ strict: false });
  const base = useQuery({ ...baseQueries.detail(baseId ?? ''), enabled: open && !!baseId });
  const role = base.data?.role;
  const canCreateView =
    !!baseId && !!tableId && (role === 'owner' || role === 'creator' || role === 'editor');
  const { create } = useCreateViewAction(baseId ?? '', tableId ?? '');
  const workspaces = useQuery({ ...workspaceQueries.list(), enabled: open });
  const bases = useQueries({
    queries: (workspaces.data?.workspaces ?? []).map((w) => ({
      ...baseQueries.list(w.id),
      enabled: open,
    })),
  }).flatMap((q) => q.data?.bases ?? []);
  const tables = useQuery({ ...tableQueries.list(baseId ?? ''), enabled: open && !!baseId });

  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      {/* On phones the palette is a full-screen sheet: room for its close button. */}
      <CommandInput
        placeholder={
          page === 'create-view' ? 'Pick a view type…' : 'Search bases, tables and commands…'
        }
        aria-label={page === 'create-view' ? 'Pick a view type' : undefined}
        value={search}
        onValueChange={setSearch}
        onKeyDown={(e) => {
          if (page !== 'root' && e.key === 'Backspace' && !search) {
            e.preventDefault();
            setPage('root');
          }
        }}
        className="max-md:mr-10"
      />
      <CommandList className="max-md:max-h-none max-md:flex-1">
        <CommandEmpty>No results.</CommandEmpty>
        {page === 'create-view' && canCreateView && (
          <CommandGroup heading="Create view">
            {VIEW_TYPE_OPTIONS.map((o) => (
              <CommandItem
                key={o.type}
                value={`view type ${o.label}`}
                disabled={o.disabled}
                onSelect={run(() => create(o.type, personal))}
              >
                <ViewTypeIcon type={o.type} />
                {o.label}
                {o.disabled && <span className="ml-auto text-small text-text-2">Soon</span>}
              </CommandItem>
            ))}
            <CommandItem value="only me personal view" onSelect={() => setPersonal((p) => !p)}>
              {personal ? <CheckIcon /> : <UserRoundIcon />}
              Only me (personal view)
              <span className="ml-auto text-small text-text-2">{personal ? 'On' : 'Off'}</span>
            </CommandItem>
          </CommandGroup>
        )}
        {page === 'root' && baseId && (tables.data?.tables.length ?? 0) > 0 && (
          <CommandGroup heading="Tables">
            {tables.data?.tables.map((t) => (
              <CommandItem
                key={t.id}
                value={`table ${t.name} ${t.id}`}
                onSelect={run(() =>
                  navigate({ to: '/b/$baseId/$tableId', params: { baseId, tableId: t.id } })
                )}
              >
                <Table2Icon />
                {t.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {page === 'root' && bases.length > 0 && (
          <CommandGroup heading="Bases">
            {bases.map((b) => (
              <CommandItem
                key={b.id}
                value={`base ${b.name} ${b.id}`}
                onSelect={run(() => navigate({ to: '/b/$baseId', params: { baseId: b.id } }))}
              >
                <DatabaseIcon />
                {b.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {page === 'root' && (
          <CommandGroup heading="Commands">
            {canCreateView && (
              <CommandItem
                value="create view new view"
                onSelect={() => {
                  setSearch('');
                  setPage('create-view');
                }}
              >
                <LayoutListIcon />
                Create view…
              </CommandItem>
            )}
            <CommandItem value="create new base" onSelect={run(() => openCreateBase())}>
              <PlusIcon />
              Create a base
            </CommandItem>
            <CommandItem value="go home" onSelect={run(() => navigate({ to: '/' }))}>
              <HomeIcon />
              Go to home
            </CommandItem>
            <CommandItem value="settings" onSelect={run(() => navigate({ to: '/settings' }))}>
              <SettingsIcon />
              Settings
            </CommandItem>
            <CommandItem
              value="help documentation docs guide"
              onSelect={run(() => window.open(DOCS_URL, '_blank', 'noopener,noreferrer'))}
            >
              <BookOpenIcon />
              Open the documentation
            </CommandItem>
            {statusPageUrl && (
              <CommandItem
                value="status uptime outage incident system status page"
                onSelect={run(() => window.open(statusPageUrl, '_blank', 'noopener,noreferrer'))}
              >
                <ActivityIcon />
                Open the status page
              </CommandItem>
            )}
            <CommandItem value="toggle dark mode theme" onSelect={run(toggle)}>
              <MoonIcon />
              {resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
