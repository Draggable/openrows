import { AUTH_ERROR_CODES } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { z } from 'zod';
import { tableQueries, viewQueries } from './api/queries';
import { AdminConsolePage } from './app/AdminConsolePage';
import { AiSettingsPage } from './app/AiSettingsPage';
import { AuditLogPage } from './app/AuditLogPage';
import { BasePage } from './app/BasePage';
import { BillingPage } from './app/BillingPage';
import { EmptyBase } from './app/EmptyBase';
import { ErrorPage, NotFoundPage } from './app/ErrorPage';
import { HomePage } from './app/HomePage';
import { InvitePage } from './app/InvitePage';
import { MembersPage } from './app/MembersPage';
import { SettingsPage } from './app/SettingsPage';
import { AuthedProviders } from './app/Shell';
import { SsoPage } from './app/SsoPage';
import { UsagePage } from './app/UsagePage';
import { Toaster, TooltipProvider } from './components/ui';
import {
  API_DOCS_PATH,
  ApiDocsPage,
  FROM_AIRTABLE_PATH,
  MCP_PATH,
  SDK_PATH,
} from './features/api-docs/ApiDocsPage';
import { ConsentPage } from './features/oauth/ConsentPage';
import { EMBED_THEMES } from './features/share/model';
import { PublicFormPage } from './features/share/PublicFormPage';
import { SharedViewPage } from './features/share/SharedViewPage';
import { meQuery } from './lib/auth';
import { LoginPage } from './pages/auth/LoginPage';

/**
 * App shell and routes: home (`/`), a workspace (`/w/:workspaceId`), its members
 * (`/w/:workspaceId/members`), an invitation link (`/invite/:token`), settings, and a base
 * (`/b/:baseId/:tableId/:viewId`; shorter base URLs redirect to the first table and view), and
 * a view shared with a link (`/s/:token`, signed in or not) and its embed page
 * (`/embed/:token`).
 *
 * Guards use `/api/me` through the query cache: signed-out visitors of a protected route go to
 * /login (with `returnTo`), signed-in visitors of /login go home.
 */
export interface RouterContext {
  queryClient: QueryClient;
}

function RootLayout() {
  const { queryClient } = rootRoute.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        <div className="min-h-screen bg-background text-foreground">
          <Outlet />
        </div>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
});

/** Parent of every route that needs a session; children read the user from `me`. */
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) {
      const returnTo = location.href === '/' ? undefined : location.href;
      throw redirect({ to: '/login', search: { returnTo } });
    }
    return { me };
  },
  component: function Authed() {
    return (
      <AuthedProviders me={authedRoute.useRouteContext().me}>
        <Outlet />
      </AuthedProviders>
    );
  },
});

const homeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  // ?template=<slug>: openrows.io/templates links to a template's preview.
  validateSearch: z.object({
    template: z
      .string()
      .max(64)
      .regex(/^[a-z0-9-]+$/)
      .optional()
      .catch(undefined),
  }),
  component: function Home() {
    return (
      <HomePage me={homeRoute.useRouteContext().me} template={homeRoute.useSearch().template} />
    );
  },
});

const workspaceRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/w/$workspaceId',
  component: function Workspace() {
    const { workspaceId } = workspaceRoute.useParams();
    return <HomePage me={workspaceRoute.useRouteContext().me} workspaceId={workspaceId} />;
  },
});

const membersRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/w/$workspaceId/members',
  component: function Members() {
    const { workspaceId } = membersRoute.useParams();
    return <MembersPage me={membersRoute.useRouteContext().me} workspaceId={workspaceId} />;
  },
});

const usageRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/w/$workspaceId/usage',
  component: function Usage() {
    const { workspaceId } = usageRoute.useParams();
    return <UsagePage me={usageRoute.useRouteContext().me} workspaceId={workspaceId} />;
  },
});

// the workspace's billing settings (owners).
const billingRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/w/$workspaceId/billing',
  component: function Billing() {
    const { workspaceId } = billingRoute.useParams();
    return <BillingPage me={billingRoute.useRouteContext().me} workspaceId={workspaceId} />;
  },
});

// the workspace's AI settings (owners).
const aiSettingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/w/$workspaceId/ai',
  component: function AiSettings() {
    const { workspaceId } = aiSettingsRoute.useParams();
    return <AiSettingsPage me={aiSettingsRoute.useRouteContext().me} workspaceId={workspaceId} />;
  },
});

// the workspace's audit log (owners; hosted Enterprise plan).
const auditLogRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/w/$workspaceId/audit-log',
  component: function AuditLog() {
    const { workspaceId } = auditLogRoute.useParams();
    return <AuditLogPage me={auditLogRoute.useRouteContext().me} workspaceId={workspaceId} />;
  },
});

// the workspace's admin console (owners; hosted Enterprise plan).
const adminConsoleRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/w/$workspaceId/admin',
  component: function AdminConsoleRoute() {
    const { workspaceId } = adminConsoleRoute.useParams();
    return (
      <AdminConsolePage me={adminConsoleRoute.useRouteContext().me} workspaceId={workspaceId} />
    );
  },
});

// the workspace's single sign-on (owners; hosted Business and Enterprise plans).
const ssoRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/w/$workspaceId/sso',
  component: function Sso() {
    const { workspaceId } = ssoRoute.useParams();
    return <SsoPage me={ssoRoute.useRouteContext().me} workspaceId={workspaceId} />;
  },
});

/** The link in an invitation email; signed-out visitors sign in first and come back. */
const inviteRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/invite/$token',
  component: function Invite() {
    return (
      <InvitePage me={inviteRoute.useRouteContext().me} token={inviteRoute.useParams().token} />
    );
  },
});

/**
 * The OAuth consent screen: an app sends the browser here; signed-out visitors sign in
 * first and come back with the same query string, which is read as it is (never re-encoded).
 */
const oauthAuthorizeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/oauth/authorize',
  component: function OAuthAuthorize() {
    return (
      <ConsentPage me={oauthAuthorizeRoute.useRouteContext().me} search={window.location.search} />
    );
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/settings',
  component: function Settings() {
    return <SettingsPage me={settingsRoute.useRouteContext().me} />;
  },
});

/** The ops console is its own chunk: only system admins open it. */
const AdminPage = lazy(() =>
  import('./features/admin/AdminPage').then((m) => ({ default: m.AdminPage }))
);

/** `/admin`: the hosted ops console; the server answers 404 to anyone but system admins. */
const adminRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/admin',
  component: function Admin() {
    return (
      <Suspense fallback={null}>
        <AdminPage me={adminRoute.useRouteContext().me} />
      </Suspense>
    );
  },
});

/** `/b/:baseId` opens the first table (or offers to add one). */
const baseRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/b/$baseId',
  loader: async ({ context, params }) => {
    const { tables } = await context.queryClient.ensureQueryData(tableQueries.list(params.baseId));
    const first = tables[0];
    if (first) {
      throw redirect({
        to: '/b/$baseId/$tableId',
        params: { baseId: params.baseId, tableId: first.id },
        replace: true,
      });
    }
  },
  component: function BaseIndex() {
    return <EmptyBase me={baseRoute.useRouteContext().me} baseId={baseRoute.useParams().baseId} />;
  },
});

/** The builder is its own chunk: only creators open it. */
const AutomationsPage = lazy(() =>
  import('./features/automations/AutomationsPage').then((m) => ({ default: m.AutomationsPage }))
);

/** Its own chunk: the designer and the page view of interfaces. */
const InterfacesPage = lazy(() =>
  import('./features/interfaces/InterfacesPage').then((m) => ({ default: m.InterfacesPage }))
);

/** `/b/:baseId/interfaces?p=<pageId>&edit=true`: a base's interfaces. */
const interfacesRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/b/$baseId/interfaces',
  validateSearch: z.object({
    p: z.string().uuid().optional().catch(undefined),
    edit: z.boolean().optional().catch(undefined),
  }),
  component: function Interfaces() {
    const { baseId } = interfacesRoute.useParams();
    const { p, edit } = interfacesRoute.useSearch();
    return (
      <Suspense fallback={null}>
        <InterfacesPage
          me={interfacesRoute.useRouteContext().me}
          baseId={baseId}
          pageId={p}
          edit={edit}
        />
      </Suspense>
    );
  },
});

const InterfaceApp = lazy(() =>
  import('./features/interfaces/InterfaceApp').then((m) => ({ default: m.InterfaceApp }))
);

/** `/i/:interfaceId?p=<pageId>`: one interface on its own (interface-only collaborators). */
const interfaceAppRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/i/$interfaceId',
  validateSearch: z.object({ p: z.string().uuid().optional().catch(undefined) }),
  component: function SharedInterface() {
    const { interfaceId } = interfaceAppRoute.useParams();
    const { p } = interfaceAppRoute.useSearch();
    return (
      <Suspense fallback={null}>
        <InterfaceApp
          me={interfaceAppRoute.useRouteContext().me}
          interfaceId={interfaceId}
          pageId={p}
        />
      </Suspense>
    );
  },
});

/** Its own chunk: the code editor and the sandbox host of browser scripts. */
const ScriptsPage = lazy(() =>
  import('./features/scripts/ScriptsPage').then((m) => ({ default: m.ScriptsPage }))
);

/** `/b/:baseId/scripts?s=<id>`: the base's saved scripts, or one with its editor and output. */
const scriptsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/b/$baseId/scripts',
  validateSearch: z.object({ s: z.string().uuid().optional().catch(undefined) }),
  component: function Scripts() {
    const { baseId } = scriptsRoute.useParams();
    const { s } = scriptsRoute.useSearch();
    return (
      <Suspense fallback={null}>
        <ScriptsPage me={scriptsRoute.useRouteContext().me} baseId={baseId} scriptId={s} />
      </Suspense>
    );
  },
});

/** `/b/:baseId/automations?a=<id>`: the base's automations, or one in the builder. */
const automationsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/b/$baseId/automations',
  validateSearch: z.object({ a: z.string().uuid().optional().catch(undefined) }),
  component: function Automations() {
    const { baseId } = automationsRoute.useParams();
    const { a } = automationsRoute.useSearch();
    return (
      <Suspense fallback={null}>
        <AutomationsPage
          me={automationsRoute.useRouteContext().me}
          baseId={baseId}
          automationId={a}
        />
      </Suspense>
    );
  },
});

/**
 * `?record=<id>` deep-links a record's expand view; `&comment=<id>` also opens its
 * comments at that comment (notification links).
 */
const viewSearch = z.object({
  record: z.string().uuid().optional().catch(undefined),
  comment: z.string().uuid().optional().catch(undefined),
});

/** `/b/:baseId/:tableId` opens the table's first view, keeping a record deep link. */
const tableRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/b/$baseId/$tableId',
  validateSearch: viewSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const { views } = await context.queryClient.ensureQueryData(viewQueries.list(params.tableId));
    const first = views[0];
    if (!first) throw new Error('A table without views');
    throw redirect({
      to: '/b/$baseId/$tableId/$viewId',
      params: { ...params, viewId: first.id },
      search: deps,
      replace: true,
    });
  },
});

const viewRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/b/$baseId/$tableId/$viewId',
  validateSearch: viewSearch,
  loader: async ({ context, params }) => {
    // Fetch in parallel; a 404 here (deleted or foreign ids) shows the error page.
    await Promise.all([
      context.queryClient.ensureQueryData(tableQueries.detail(params.tableId)),
      context.queryClient.ensureQueryData(viewQueries.list(params.tableId)),
    ]);
  },
  component: function View() {
    const params = viewRoute.useParams();
    // `comment` is read by the record expand view itself (RecordExpand: commentFromUrl).
    const { record } = viewRoute.useSearch();
    return <BasePage me={viewRoute.useRouteContext().me} {...params} recordId={record} />;
  },
});

const loginSearch = z.object({
  error: z.enum(AUTH_ERROR_CODES).optional().catch(undefined),
  returnTo: z.string().optional().catch(undefined),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: loginSearch,
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me && !search.error) throw redirect({ to: '/' });
  },
  component: function Login() {
    const { error, returnTo } = loginRoute.useSearch();
    return <LoginPage error={error} returnTo={returnTo} />;
  },
});

/** A view or base shared with a link: public, no session, no app shell. */
const sharedViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/s/$token',
  // A base link's selected view.
  validateSearch: z.object({ view: z.uuid().optional().catch(undefined) }),
  component: function SharedView() {
    const { token } = sharedViewRoute.useParams();
    const { view } = sharedViewRoute.useSearch();
    const navigate = sharedViewRoute.useNavigate();
    return (
      <SharedViewPage
        token={token}
        viewId={view}
        onSelectView={(id) => void navigate({ search: { view: id }, replace: true })}
      />
    );
  },
});

/** A public form: anyone with the link fills it in; no session, no app shell. */
const publicFormRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/f/$token',
  component: function PublicFormRoute() {
    const { token } = publicFormRoute.useParams();
    return <PublicFormPage token={token} />;
  },
});

/**
 * A share link's embed page: the same page, compact, for other sites' iframes (the server
 * lets only the link's embed origins frame it). `theme` is light (the default), dark or auto.
 */
const embedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/embed/$token',
  validateSearch: z.object({
    view: z.uuid().optional().catch(undefined),
    theme: z.enum(EMBED_THEMES).optional().catch(undefined),
  }),
  component: function Embed() {
    const { token } = embedRoute.useParams();
    const { view, theme } = embedRoute.useSearch();
    const navigate = embedRoute.useNavigate();
    return (
      <SharedViewPage
        token={token}
        viewId={view}
        embed={{ theme: theme ?? 'light' }}
        onSelectView={(id) => void navigate({ search: (s) => ({ ...s, view: id }), replace: true })}
      />
    );
  },
});

/** The API reference: public, no session, no app shell. */
const apiDocsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: API_DOCS_PATH,
  component: () => <ApiDocsPage />,
});

/** The API reference's "From Airtable" page. */
const fromAirtableRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: FROM_AIRTABLE_PATH,
  component: () => <ApiDocsPage page="airtable" />,
});

/** The JavaScript SDK's page of the API reference. */
const sdkDocsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: SDK_PATH,
  component: () => <ApiDocsPage page="sdk" />,
});

/** The MCP server's page of the API reference. */
const mcpDocsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: MCP_PATH,
  component: () => <ApiDocsPage page="mcp" />,
});

const routeTree = rootRoute.addChildren([
  authedRoute.addChildren([
    homeRoute,
    workspaceRoute,
    membersRoute,
    usageRoute,
    billingRoute,
    aiSettingsRoute,
    auditLogRoute,
    adminConsoleRoute,
    ssoRoute,
    inviteRoute,
    oauthAuthorizeRoute,
    settingsRoute,
    adminRoute,
    baseRoute,
    automationsRoute,
    scriptsRoute,
    interfacesRoute,
    interfaceAppRoute,
    tableRoute,
    viewRoute,
  ]),
  loginRoute,
  sharedViewRoute,
  embedRoute,
  publicFormRoute,
  apiDocsRoute,
  fromAirtableRoute,
  sdkDocsRoute,
  mcpDocsRoute,
]);

/** Creates the app router. Tests pass a memory history and their own query client. */
export function createAppRouter(
  options: { history?: RouterHistory; queryClient?: QueryClient } = {}
) {
  const queryClient = options.queryClient ?? new QueryClient();
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultErrorComponent: ErrorPage,
    ...(options.history ? { history: options.history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
