import type { MeResponse } from '@openrows/shared';
import { Link, type LinkProps, useRouterState } from '@tanstack/react-router';
import {
  HomeIcon,
  LogOutIcon,
  MenuIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  XIcon,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '../components/ui';
import { ImpersonationBanner } from '../features/admin/ImpersonationBanner';
import { AirtableImportWatcher } from '../features/airtable/AirtableImportWatcher';
import { NoticeBanner } from '../features/notices/NoticeBanner';
import { NotificationBell } from '../features/notifications/NotificationBell';
import { OfflineBanner } from '../features/offline/OfflineBanner';
import { SignOutForm } from '../features/offline/SignOutForm';
import { RealtimeProvider } from '../features/realtime/RealtimeProvider';
import { MOBILE_QUERY, RAIL_QUERY, useMediaQuery } from '../lib/media';
import { isEdgeSwipe, type Point, swipeDirection } from '../lib/swipe';
import { useTheme } from '../lib/theme';
import { cn } from '../lib/utils';
import { AppActionsContext, useAppActions } from './AppContext';
import { CommandPalette } from './CommandPalette';
import { CreateBaseDialog } from './CreateBaseDialog';
import { HelpMenu } from './HelpMenu';
import { initials } from './names';

/** Wraps every signed-in screen: the command palette, the create-base dialog, Ctrl/⌘ K. */
export function AuthedProviders({ me, children }: { me: MeResponse; children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [createBase, setCreateBase] = useState<{ open: boolean; workspaceId?: string }>({
    open: false,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openCreateBase = useCallback(
    (workspaceId?: string) => setCreateBase({ open: true, workspaceId }),
    []
  );
  const actions = useMemo(
    () => ({ openPalette: () => setPaletteOpen(true), openCreateBase }),
    [openCreateBase]
  );

  return (
    <AppActionsContext.Provider value={actions}>
      <RealtimeProvider>{children}</RealtimeProvider>
      <AirtableImportWatcher />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <CreateBaseDialog
        me={me}
        open={createBase.open}
        workspaceId={createBase.workspaceId}
        onOpenChange={(open) => setCreateBase((s) => ({ ...s, open }))}
      />
    </AppActionsContext.Provider>
  );
}

/** The shell's navigation state, for the menu button in the page headers. */
type ShellNav = {
  /** Below 768 px: the sidebar is a drawer. */
  mobile: boolean;
  /** 768–1023 px: the sidebar can collapse to a rail. */
  rail: boolean;
  collapsed: boolean;
  drawerOpen: boolean;
  openDrawer: () => void;
  setCollapsed: (collapsed: boolean) => void;
  /** The menu button, which gets focus back when the drawer closes. */
  menuButton: RefObject<HTMLButtonElement | null>;
};
const ShellNavContext = createContext<ShellNav | null>(null);
const COLLAPSED_KEY = 'openrows-sidebar-collapsed';
const DRAWER_ID = 'app-drawer';

function storedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Two-column layout: the 248 px sidebar and the page. Below 768 px the sidebar is an off-canvas
 * drawer (the menu button in the page header or a swipe from the left edge opens it; the scrim,
 * Esc, a swipe left or a navigation close it), from 768 to 1023 px it can collapse to a rail,
 * and the page keeps clear of the safe-area insets.
 */
export function Shell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const mobile = useMediaQuery(MOBILE_QUERY);
  const rail = useMediaQuery(RAIL_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsedState] = useState(storedCollapsed);
  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState(value);
    try {
      if (value) localStorage.setItem(COLLAPSED_KEY, '1');
      else localStorage.removeItem(COLLAPSED_KEY);
    } catch {
      // Private mode: the choice lasts for the page.
    }
  }, []);
  // The drawer closes on navigation (switching a table or view keeps this shell mounted).
  const path = useRouterState({ select: (s) => s.location.pathname });
  // biome-ignore lint/correctness/useExhaustiveDependencies: close whenever the path changes
  useEffect(() => setDrawerOpen(false), [path]);
  useEffect(() => {
    if (!mobile) setDrawerOpen(false);
  }, [mobile]);
  // A swipe to the right from the screen's left edge opens the drawer.
  useEffect(() => {
    if (!mobile || drawerOpen) return;
    let start: Point | null = null;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
    };
    const onEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (start && t && isEdgeSwipe(start, { x: t.clientX, y: t.clientY })) setDrawerOpen(true);
      start = null;
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchend', onEnd);
    };
  }, [mobile, drawerOpen]);
  const nav = useMemo<ShellNav>(
    () => ({
      mobile,
      rail,
      collapsed: rail && collapsed,
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      setCollapsed,
      menuButton,
    }),
    [mobile, rail, collapsed, drawerOpen, setCollapsed]
  );

  return (
    <ShellNavContext.Provider value={nav}>
      <div className="flex h-dvh overflow-hidden bg-app pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-text">
        {mobile ? (
          <SidebarDrawer
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            onCloseAutoFocus={(e) => {
              if (!menuButton.current) return;
              e.preventDefault();
              menuButton.current.focus();
            }}
          >
            {sidebar}
          </SidebarDrawer>
        ) : nav.collapsed ? (
          <SidebarRail onExpand={() => setCollapsed(false)} />
        ) : (
          <aside
            aria-label="Sidebar"
            className="flex w-[248px] shrink-0 flex-col border-r border-border bg-sidebar"
          >
            {sidebar}
          </aside>
        )}
        <div data-testid="page" className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ImpersonationBanner />
          <OfflineBanner />
          <NoticeBanner />
          {children}
        </div>
      </div>
    </ShellNavContext.Provider>
  );
}

/** The sidebar as a modal drawer from the left: focus trap, Esc, scrim and swipe close it. */
function SidebarDrawer({
  open,
  onOpenChange,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (e: Event) => void;
  children: ReactNode;
}) {
  const swipe = useRef<Point | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid="drawer-scrim"
          className="fixed inset-0 z-40 bg-scrim"
        />
        <DialogPrimitive.Content
          id={DRAWER_ID}
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          onTouchStart={(e) => {
            const t = e.touches[0];
            swipe.current = t ? { x: t.clientX, y: t.clientY } : null;
          }}
          onTouchEnd={(e) => {
            const start = swipe.current;
            const t = e.changedTouches[0];
            swipe.current = null;
            if (!start || !t) return;
            if (swipeDirection(start, { x: t.clientX, y: t.clientY }) === 'left')
              onOpenChange(false);
          }}
          className="drawer fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col border-r border-border bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-text shadow-3 outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          {children}
          <DialogPrimitive.Close
            aria-label="Close navigation"
            className="absolute top-[calc(env(safe-area-inset-top)+6px)] right-2 flex size-[40px] items-center justify-center rounded-sm text-text-2 hover:bg-hover"
          >
            <XIcon className="size-4" aria-hidden />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** The collapsed sidebar (768–1023 px): expand, home and search, each with a tooltip. */
function SidebarRail({ onExpand }: { onExpand: () => void }) {
  const { openPalette } = useAppActions();
  const item =
    'flex size-9 items-center justify-center rounded-sm text-text-2 hover:bg-hover hover:text-text [&_svg]:size-4';
  return (
    <nav
      aria-label="Sidebar"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-2"
    >
      <Tooltip content="Expand sidebar" side="right">
        <button type="button" aria-label="Expand sidebar" onClick={onExpand} className={item}>
          <PanelLeftOpenIcon aria-hidden />
        </button>
      </Tooltip>
      <Tooltip content="Home" side="right">
        <Link to="/" aria-label="Home" className={item}>
          <HomeIcon aria-hidden />
        </Link>
      </Tooltip>
      <Tooltip content="Search and commands" side="right">
        <button
          type="button"
          aria-label="Search and commands"
          onClick={openPalette}
          className={item}
        >
          <SearchIcon aria-hidden />
        </button>
      </Tooltip>
    </nav>
  );
}

/**
 * The page header's navigation button: the menu (opens the drawer) below 768 px, "collapse
 * sidebar" from 768 to 1023 px, nothing on wider screens.
 */
export function NavToggle() {
  const nav = useContext(ShellNavContext);
  if (!nav) return null;
  if (nav.mobile) {
    return (
      <Button
        ref={nav.menuButton}
        variant="ghost"
        size="icon"
        aria-label="Open navigation"
        aria-haspopup="dialog"
        aria-expanded={nav.drawerOpen}
        aria-controls={nav.drawerOpen ? DRAWER_ID : undefined}
        onClick={nav.openDrawer}
        className="-ml-1 size-[40px]"
      >
        <MenuIcon aria-hidden />
      </Button>
    );
  }
  if (nav.rail && !nav.collapsed) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label="Collapse sidebar"
        onClick={() => nav.setCollapsed(true)}
        className="-ml-2"
      >
        <PanelLeftCloseIcon aria-hidden />
      </Button>
    );
  }
  return null;
}

export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between px-4 pt-3">
      <h2 className="text-caps font-semibold tracking-[0.06em] text-text-2 uppercase">
        {children}
      </h2>
      {action}
    </div>
  );
}

/**
 * A sidebar navigation item. The active one gets the only allowed left accent bar (3 px,
 * flush to the sidebar edge) and the selected tint (DESIGN.md §7).
 */
export function NavItem({
  active,
  icon,
  children,
  className,
  onDoubleClick,
  ...link
}: LinkProps & {
  active?: boolean;
  icon?: ReactNode;
  className?: string;
  onDoubleClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Link
      {...link}
      onDoubleClick={onDoubleClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative mx-2 flex h-8 items-center pointer-coarse:h-[40px] gap-2.5 rounded-sm px-2.5 text-body text-text hover:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-2',
        active &&
          'bg-brand-tint font-[550] text-brand-text before:absolute before:top-0 before:bottom-0 before:-left-2 before:w-[3px] before:bg-brand hover:bg-brand-tint [&_svg]:text-brand-text',
        className
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </Link>
  );
}

/** The `Ctrl K  Search & commands` pill at the bottom of the sidebar. */
export function CommandHint() {
  const { openPalette } = useAppActions();
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button
      type="button"
      onClick={openPalette}
      className="mx-3 mb-2 flex h-9 items-center gap-1.5 rounded-sm border border-border bg-surface px-2 text-small text-text-2 hover:bg-hover pointer-coarse:h-[40px]"
    >
      {/* No keyboard shortcut hint on touch screens. */}
      <span className="flex gap-1.5 pointer-coarse:hidden">
        <kbd className="rounded-xs border border-border px-1.5 font-sans">{mac ? '⌘' : 'Ctrl'}</kbd>
        <kbd className="rounded-xs border border-border px-1.5 font-sans">K</kbd>
      </span>
      <SearchIcon className="hidden size-4 pointer-coarse:block" aria-hidden />
      <span className="ml-1">Search &amp; commands</span>
    </button>
  );
}

/** Avatar, name and email, with a menu: theme, settings, sign out. */
export function AccountRow({ me }: { me: MeResponse }) {
  const { resolved, toggle } = useTheme();
  const signOut = useRef<HTMLFormElement>(null);
  const { name, email } = me.user;
  const label = name ?? email ?? 'Account';
  return (
    <div className="border-t border-border p-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex w-full items-center gap-2.5 rounded-sm p-1.5 text-left hover:bg-hover"
          aria-label="Account menu"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#1F9AA8]/25 text-small font-semibold text-[#0E4F57] dark:bg-[#1F9AA8]/35 dark:text-[#7DD3DC]">
            {initials(label)}
          </span>
          <span className="min-w-0 flex-1" data-testid="current-user">
            <span className="block truncate font-[550]">{label}</span>
            {name && email && (
              <span className="block truncate text-small text-text-2">{email}</span>
            )}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuItem onSelect={toggle}>
            {resolved === 'dark' ? <SunIcon /> : <MoonIcon />}
            {resolved === 'dark' ? 'Light mode' : 'Dark mode'}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings">
              <SettingsIcon />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => signOut.current?.requestSubmit()}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* A form POST, once the offline data is deleted. */}
      <SignOutForm ref={signOut} hidden />
    </div>
  );
}

/**
 * Page header bar (52 px): the navigation button, breadcrumb or title on the left, actions,
 * help and notifications on the right. It is the `topbar` container: actions can collapse
 * their labels by its width.
 */
export function TopBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <header className="@container/topbar flex h-[52px] shrink-0 items-center justify-between gap-2 border-b border-border px-3 sm:gap-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <NavToggle />
        {children}
      </div>
      <div className="flex items-center gap-1 sm:gap-2">
        {actions}
        <HelpMenu />
        <NotificationBell />
      </div>
    </header>
  );
}
