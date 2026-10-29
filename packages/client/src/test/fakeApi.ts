import {
  contracts,
  type ErrorCode,
  type InvitationPreview,
  type MeResponse,
  type Notice,
  type Notification,
  type SharedRecord,
  type SharedShare,
  type SharedView,
} from '@openrows/shared';
import { vi } from 'vitest';

type Row = Record<string, unknown> & {
  id: string;
  name?: string;
  workspaceId?: string;
  baseId?: string | null;
  tableId?: string;
};

/**
 * An in-memory stand-in for the API, enough for the shell's screens: workspaces, bases,
 * tables (with a Name field), views and empty record queries. Answers follow the contracts.
 */
export function stubApi(me: MeResponse) {
  const now = '2026-10-25T10:00:00.000Z';
  const stamp = { createdAt: now, updatedAt: now };
  const workspaces: Row[] = [];
  const bases: Row[] = [];
  const tables: Row[] = [];
  const views: Row[] = [];
  const sections: Row[] = [];
  const members: Row[] = [];
  const invitations: Row[] = [];
  /** Base collaborators, by base: `{ baseId, userId, ..., role }`. */
  const baseCollaborators: Row[] = [];
  /** Invitation previews by token, for `/invite/:token`. */
  const previews: Record<string, InvitationPreview> = {};
  const calls: string[] = [];
  /** The user's notifications, newest first. */
  const notifications: Notification[] = [];
  let emailPreference = 'all';
  let emailFrequency = 'immediately';
  /** Service notices the user hasn't dismissed. */
  const notices: Notice[] = [];
  /** Personal access tokens, without their secrets. */
  const tokens: Row[] = [];
  /** OAuth apps: the ones registered here, the ones authorized, and consent answers. */
  const oauthApps: Row[] = [];
  const authorizations: Row[] = [];
  const decisions: Row[] = [];
  /** Workspace usage by workspace id. */
  const usage: Record<string, unknown> = {};
  /** Workspace billing by workspace id. */
  const billing: Record<string, unknown> = {};
  /** AI settings by workspace id (AiSettings), what PUT got, and the test's answer. */
  const ai: Record<string, Record<string, unknown>> = {};
  const aiSaves: Record<string, unknown>[] = [];
  const aiTest: { result: Record<string, unknown> | null } = { result: null };
  /**
   * The audit log by workspace id: its entries (newest first) and stream, or `refuse:
   * 'plan'` (403 PLAN_FEATURE_REQUIRED). No entry: 404, as on a self-hosted server.
   */
  const audit: Record<
    string,
    { events: Record<string, unknown>[]; stream: Record<string, unknown> | null; refuse?: 'plan' }
  > = {};
  /** A base's plan-limit warnings by base id; none by default. */
  const baseUsageWarnings: Record<string, unknown> = {};
  /** View and base share links: `{ id, viewId | baseId, ... }`. */
  const shares: Row[] = [];
  /** The public `/auth/providers` answer: sign-in buttons and the status page link. */
  const signIn: { providers: string[]; statusPageUrl: string | null } = {
    providers: [],
    statusPageUrl: null,
  };
  /**
   * The public side by token: the summary, each view's page and records, and what it asks
   * first (a password, which `unlock` checks, or a refusal code).
   */
  const shared: Record<
    string,
    {
      share: SharedShare;
      views: Record<string, { view: SharedView; records: SharedRecord[] }>;
      password?: string;
      refuse?: ErrorCode;
    }
  > = {};
  const unlocked = new Set<string>();
  const problem = (code: ErrorCode, status: number) =>
    json(
      { type: 'about:blank', title: code, status, code, requestId: 'fake', detail: code },
      status
    );

  const json = (data: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(data), { status });
  const find = (list: Row[], id: string) => list.find((x) => x.id === id);
  const summary = ({ fields: _f, ...t }: Row) => t;

  function addView(tableId: string, name: string, personal = false, type = 'grid') {
    const position = views.filter((v) => v.tableId === tableId).length + 1;
    const view = {
      id: crypto.randomUUID(),
      tableId,
      name,
      type,
      position,
      config: {},
      personal,
      locked: false,
      sectionId: null,
      createdBy: me.user.id,
      ...stamp,
    };
    views.push(view);
    return view;
  }

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    const at = (re: RegExp) => path.match(re)?.[1];

    if (path === contracts.me.get.path) return json(me);
    if (path === '/auth/providers') return json(signIn);
    const unread = () => notifications.filter((n) => n.readAt === null).length;
    if (path === contracts.notifications.unread.path) return json({ unread: unread() });
    if (path === contracts.notifications.list.path) {
      return json({ notifications, nextCursor: null, unread: unread() });
    }
    if (path === contracts.notifications.markAllRead.path && method === 'POST') {
      for (const n of notifications) n.readAt ??= now;
      return json({ unread: 0 });
    }
    const readId = at(/^\/api\/notifications\/([^/]+)\/read$/);
    if (readId && method === 'POST') {
      const n = notifications.find((x) => x.id === readId);
      if (n) n.readAt ??= now;
      return json({ unread: unread() });
    }
    if (path === contracts.notices.list.path) return json({ notices });
    const noticeId = at(/^\/api\/me\/notices\/([^/]+)\/dismiss$/);
    if (noticeId && method === 'POST') {
      const i = notices.findIndex((n) => n.id === noticeId);
      if (i < 0) return problem('NOT_FOUND', 404);
      notices.splice(i, 1);
      return json(null, 204);
    }
    if (path === contracts.tokens.list.path) {
      if (method === 'POST') {
        const id = crypto.randomUUID();
        const prefix = `or_pat_${id.replaceAll('-', '').slice(0, 12)}`;
        const token = {
          id,
          name: body.name,
          prefix,
          scopes: body.scopes,
          workspaceIds: body.workspaceIds ?? [],
          baseIds: body.baseIds ?? [],
          createdAt: now,
          expiresAt: '2999-01-01T00:00:00.000Z',
          lastUsedAt: null,
          usage: Array.from({ length: 7 }, (_, i) => ({
            day: `2026-10-${String(20 + i).padStart(2, '0')}`,
            requests: i === 6 ? 12 : i,
          })),
        };
        tokens.unshift(token);
        return json({ ...token, token: `${prefix}_${'s'.repeat(43)}` }, 201);
      }
      return json({ tokens });
    }
    const tokenId = at(/^\/api\/me\/tokens\/([^/]+)$/);
    if (tokenId && method === 'DELETE') {
      const i = tokens.findIndex((k) => k.id === tokenId);
      if (i < 0) return problem('NOT_FOUND', 404);
      tokens.splice(i, 1);
      return json(null, 204);
    }
    if (path === contracts.oauthApps.list.path) {
      if (method === 'POST') {
        const app = {
          id: crypto.randomUUID(),
          name: body.name,
          description: body.description ?? '',
          homepageUrl: body.homepageUrl ?? null,
          clientId: `or_app_${'a'.repeat(20)}`,
          redirectUris: body.redirectUris,
          createdAt: now,
          updatedAt: now,
        };
        oauthApps.unshift(app);
        return json({ ...app, clientSecret: `or_secret_${'s'.repeat(43)}` }, 201);
      }
      return json({ apps: oauthApps });
    }
    const appId = at(/^\/api\/me\/oauth-apps\/([^/]+)$/);
    if (appId) {
      const i = oauthApps.findIndex((a) => a.id === appId);
      if (i < 0) return problem('NOT_FOUND', 404);
      if (method === 'DELETE') {
        oauthApps.splice(i, 1);
        return json(null, 204);
      }
      const { rotateSecret, ...change } = body;
      Object.assign(oauthApps[i] as Row, change);
      return json({
        ...oauthApps[i],
        clientSecret: rotateSecret ? `or_secret_${'r'.repeat(43)}` : null,
      });
    }
    if (path === contracts.oauthAuthorizations.list.path) return json({ authorizations });
    const authorizationId = at(/^\/api\/me\/authorizations\/([^/]+)$/);
    if (authorizationId && method === 'DELETE') {
      const i = authorizations.findIndex((a) => a.id === authorizationId);
      if (i < 0) return problem('NOT_FOUND', 404);
      authorizations.splice(i, 1);
      return json(null, 204);
    }
    if (path === contracts.oauthAuthorizations.check.path) {
      if (method === 'POST') {
        decisions.push(body);
        const back = new URL(body.redirectUri);
        if (body.decision === 'deny') back.searchParams.set('error', 'access_denied');
        else back.searchParams.set('code', 'the-code');
        if (body.state) back.searchParams.set('state', body.state);
        return json({ redirectTo: back.toString() });
      }
      const q = url.searchParams;
      if (q.get('client_id') !== 'or_app_known') {
        return new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Validation failed',
            status: 422,
            code: 'VALIDATION_FAILED',
            detail: 'This app is not registered (unknown client_id).',
            requestId: 'fake',
          }),
          { status: 422, headers: { 'content-type': 'application/problem+json' } }
        );
      }
      return json({
        app: { name: 'Acme Sync', description: 'Syncs rows', homepageUrl: 'https://acme.test' },
        clientId: 'or_app_known',
        redirectUri: q.get('redirect_uri') ?? 'https://acme.test/cb',
        scopes: (q.get('scope') ?? '').split(' '),
        current: null,
      });
    }
    if (path === contracts.notifications.preferences.path) {
      if (method === 'PUT') {
        emailPreference = body.email ?? emailPreference;
        emailFrequency = body.frequency ?? emailFrequency;
      }
      return json({ email: emailPreference, frequency: emailFrequency });
    }
    if (path === contracts.workspaces.list.path) {
      if (method === 'POST') {
        const ws = { id: crypto.randomUUID(), name: body.name, role: 'owner', ...stamp };
        workspaces.push(ws);
        return json(ws, 201);
      }
      return json({ workspaces });
    }
    const workspaceDetail = at(/^\/api\/workspaces\/([^/]+)$/);
    if (workspaceDetail) return json(find(workspaces, workspaceDetail));
    const usageOf = at(/^\/api\/workspaces\/([^/]+)\/usage$/);
    if (usageOf) return usage[usageOf] ? json(usage[usageOf]) : json({ title: 'Not found' }, 404);
    const billingOf = at(/^\/api\/workspaces\/([^/]+)\/billing$/);
    if (billingOf) {
      return billing[billingOf] ? json(billing[billingOf]) : json({ title: 'Not found' }, 404);
    }
    const aiOf = at(/^\/api\/workspaces\/([^/]+)\/ai$/);
    if (aiOf) {
      const source = ai[aiOf]?.['source'] ?? null;
      return json({ workspaceId: aiOf, available: source !== null, source });
    }
    const auditOf = at(/^\/api\/workspaces\/([^/]+)\/audit-log(?:\/stream)?$/);
    if (auditOf) {
      const log = audit[auditOf];
      if (!log) return problem('NOT_FOUND', 404);
      if (log.refuse) return problem('PLAN_FEATURE_REQUIRED', 403);
      if (path.endsWith('/stream')) {
        if (method === 'DELETE') {
          log.stream = null;
          return new Response(null, { status: 204 });
        }
        if (method === 'PUT') {
          const created = log.stream === null;
          log.stream = {
            url: body.url,
            enabled: body.enabled ?? true,
            lastDeliveryAt: null,
            lastError: null,
            failures: 0,
            createdAt: now,
          };
          const secret = created || body.rotateSecret ? 'whsec_fake-secret' : null;
          return json({ stream: log.stream, secret });
        }
        return json({ stream: log.stream });
      }
      const action = url.searchParams.get('action');
      const events = log.events.filter(
        (e) => !action || e['action'] === action || String(e['action']).startsWith(`${action}.`)
      );
      return json({ events, nextBefore: null, retentionDays: 365 });
    }
    const aiSettingsOf = at(/^\/api\/workspaces\/([^/]+)\/ai\/settings$/);
    if (aiSettingsOf) {
      const current = ai[aiSettingsOf] ?? {
        workspaceId: aiSettingsOf,
        source: null,
        instance: { available: false, model: null },
        workspace: null,
        allowedHosts: null,
      };
      if (method === 'PUT') {
        aiSaves.push(body);
        current['workspace'] = {
          baseUrl: body.baseUrl,
          model: body.model,
          hasKey: true,
          updatedAt: new Date().toISOString(),
        };
        current['source'] = 'workspace';
      }
      if (method === 'DELETE') {
        current['workspace'] = null;
        current['source'] = (current['instance'] as { available: boolean }).available
          ? 'instance'
          : null;
      }
      ai[aiSettingsOf] = current;
      return json(current);
    }
    if (at(/^\/api\/workspaces\/([^/]+)\/ai\/settings\/test$/)) {
      return aiTest.result ? json(aiTest.result) : problem('CONFLICT', 409);
    }
    const warningsOf = at(/^\/api\/bases\/([^/]+)\/usage-warnings$/);
    if (warningsOf) {
      const base = bases.find((b) => b['id'] === warningsOf);
      return json(
        baseUsageWarnings[warningsOf] ?? {
          workspaceId: base?.['workspaceId'] ?? crypto.randomUUID(),
          plan: { id: 'self-hosted', name: 'Self-hosted' },
          warnings: [],
          upgradeUrl: null,
        }
      );
    }
    const membersOf = at(/^\/api\/workspaces\/([^/]+)\/members$/);
    if (membersOf) return json({ members: members.filter((m) => m.workspaceId === membersOf) });
    const member = path.match(/^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/);
    if (member) {
      const i = members.findIndex((m) => m.workspaceId === member[1] && m['userId'] === member[2]);
      if (method === 'DELETE') {
        members.splice(i, 1);
        return json(null, 204);
      }
      Object.assign(members[i] ?? {}, body);
      return json(members[i]);
    }
    const invitationsOf = at(/^\/api\/workspaces\/([^/]+)\/invitations$/);
    if (invitationsOf) {
      if (method === 'POST') {
        const inv = {
          id: crypto.randomUUID(),
          workspaceId: invitationsOf,
          baseId: null,
          email: String(body.email).trim().toLowerCase(),
          role: body.role ?? 'editor',
          invitedByName: me.user.name,
          expiresAt: '2026-11-01T10:00:00.000Z',
          sentAt: now,
          createdAt: now,
          emailSent: true,
        };
        invitations.push(inv);
        return json(inv, 201);
      }
      return json({
        invitations: invitations.filter((i) => i.workspaceId === invitationsOf && !i.baseId),
      });
    }
    const invitation = path.match(/^\/api\/workspaces\/[^/]+\/invitations\/([^/]+)(\/resend)?$/);
    if (invitation) {
      const i = invitations.findIndex((x) => x.id === invitation[1]);
      if (method === 'DELETE') {
        invitations.splice(i, 1);
        return json(null, 204);
      }
      return json({ ...invitations[i], sentAt: now, emailSent: true });
    }
    const token = path.match(/^\/api\/invitations\/([^/]+)(\/accept)?$/);
    if (token?.[1]) {
      const preview = previews[token[1]];
      if (!preview) return json({ code: 'NOT_FOUND', status: 404, title: 'Not found' }, 404);
      if (!token[2]) return json(preview);
      const ws = { id: preview.workspaceId, name: preview.workspaceName, role: preview.role };
      workspaces.push({ ...ws, ...stamp });
      return json({ ...ws, ...stamp });
    }
    const workspaceId = at(/^\/api\/workspaces\/([^/]+)\/bases$/);
    if (workspaceId) {
      if (method === 'POST') {
        const base = {
          id: crypto.randomUUID(),
          workspaceId,
          name: body.name,
          description: null,
          icon: null,
          color: null,
          role: 'owner',
          ...stamp,
        };
        bases.push(base);
        return json(base, 201);
      }
      return json({ bases: bases.filter((b) => b.workspaceId === workspaceId) });
    }
    const collaboratorsOf = at(/^\/api\/bases\/([^/]+)\/collaborators$/);
    if (collaboratorsOf) {
      return json({
        collaborators: baseCollaborators
          .filter((c) => c.baseId === collaboratorsOf)
          .map(({ id: _id, baseId: _b, ...c }) => c),
      });
    }
    const collaborator = path.match(/^\/api\/bases\/([^/]+)\/collaborators\/([^/]+)$/);
    if (collaborator) {
      const i = baseCollaborators.findIndex(
        (c) => c.baseId === collaborator[1] && c['userId'] === collaborator[2]
      );
      const row = baseCollaborators[i];
      if (!row) return json({ code: 'NOT_FOUND', status: 404, title: 'Not found' }, 404);
      if (method === 'DELETE') {
        baseCollaborators.splice(i, 1);
        return json(null, 204);
      }
      Object.assign(row, { baseRole: body.role, role: body.role });
      const { id: _id, baseId: _b, ...rest } = row;
      return json(rest);
    }
    const baseInvitationsOf = at(/^\/api\/bases\/([^/]+)\/invitations$/);
    if (baseInvitationsOf) {
      const base = find(bases, baseInvitationsOf);
      if (method === 'POST') {
        const inv = {
          id: crypto.randomUUID(),
          workspaceId: base?.workspaceId,
          baseId: baseInvitationsOf,
          email: String(body.email).trim().toLowerCase(),
          role: body.role ?? 'editor',
          invitedByName: me.user.name,
          expiresAt: '2026-11-01T10:00:00.000Z',
          sentAt: now,
          createdAt: now,
          emailSent: true,
        };
        invitations.push(inv);
        return json(inv, 201);
      }
      return json({ invitations: invitations.filter((i) => i.baseId === baseInvitationsOf) });
    }
    const baseInvitation = path.match(/^\/api\/bases\/[^/]+\/invitations\/([^/]+)(\/resend)?$/);
    if (baseInvitation) {
      const i = invitations.findIndex((x) => x.id === baseInvitation[1]);
      if (method === 'DELETE') {
        invitations.splice(i, 1);
        return json(null, 204);
      }
      return json({ ...invitations[i], sentAt: now, emailSent: true });
    }
    const baseDetail = at(/^\/api\/bases\/([^/]+)$/);
    if (baseDetail) return json(find(bases, baseDetail));
    const baseId = at(/^\/api\/bases\/([^/]+)\/tables$/);
    if (baseId) {
      if (method === 'POST') {
        const id = crypto.randomUUID();
        const table = {
          id,
          baseId,
          name: body.name,
          description: null,
          icon: null,
          position: tables.length + 1,
          schemaVersion: 1,
          fields: [
            {
              id: crypto.randomUUID(),
              tableId: id,
              name: body.primaryFieldName ?? 'Name',
              description: null,
              type: 'singleLineText',
              options: {},
              isPrimary: true,
              position: 1,
              deletedAt: null,
              ...stamp,
            },
          ],
          ...stamp,
        };
        tables.push(table);
        addView(id, 'Grid view');
        return json(table, 201);
      }
      return json({ tables: tables.filter((t) => t.baseId === baseId).map(summary) });
    }
    const tableDetail = at(/^\/api\/tables\/([^/]+)$/);
    if (tableDetail) return json(find(tables, tableDetail));
    const tableId = at(/^\/api\/tables\/([^/]+)\/views$/);
    if (tableId) {
      if (method === 'POST')
        return json(addView(tableId, body.name, body.personal ?? false, body.type ?? 'grid'), 201);
      return json({
        views: views.filter((v) => v.tableId === tableId),
        sections: sections.filter((s) => s.tableId === tableId),
      });
    }
    const sectionsOf = at(/^\/api\/tables\/([^/]+)\/view-sections$/);
    if (sectionsOf && method === 'POST') {
      const section = {
        id: crypto.randomUUID(),
        tableId: sectionsOf,
        name: body.name,
        position: sections.length + 1,
      };
      sections.push(section);
      return json(section, 201);
    }
    const sharesOf = path.match(/^\/api\/(views|bases)\/([^/]+)\/shares$/);
    if (sharesOf) {
      const key = sharesOf[1] === 'views' ? 'viewId' : 'baseId';
      const owner = sharesOf[2] ?? '';
      if (method === 'POST') {
        const share = {
          id: crypto.randomUUID(),
          kind: key === 'viewId' ? 'view' : 'base',
          viewId: key === 'viewId' ? owner : null,
          baseId: key === 'baseId' ? owner : crypto.randomUUID(),
          createdBy: me.user.id,
          createdAt: now,
          expiresAt: body.expiresAt ?? null,
          expired: false,
          hasPassword: typeof body.password === 'string',
          allowedDomains: body.allowedDomains ?? [],
          allowCopy: body.allowCopy ?? true,
          allowDownload: body.allowDownload ?? false,
          embedOrigins: body.embedOrigins ?? [],
          allowRestrictedEmbed: body.allowRestrictedEmbed ?? false,
          ...(key === 'viewId' ? {} : { scope: owner }),
        };
        shares.unshift(share);
        return json({ share, token: 'T'.repeat(43) }, 201);
      }
      return json({
        shares: shares.filter((x) =>
          key === 'viewId' ? x['viewId'] === owner : x['scope'] === owner
        ),
      });
    }
    const oneShare = path.match(/^\/api\/(views|bases)\/[^/]+\/shares\/([^/]+)$/);
    if (oneShare) {
      const id = oneShare[2] ?? '';
      if (method === 'DELETE') {
        shares.splice(
          shares.findIndex((x) => x.id === id),
          1
        );
        return json(null, 204);
      }
      if (method === 'PATCH') {
        const share = find(shares, id);
        if (!share) return problem('NOT_FOUND', 404);
        const { password, ...rest } = body;
        Object.assign(share, rest);
        if (password !== undefined) share['hasPassword'] = password !== null;
        return json(share);
      }
    }
    const sharedPath = path.match(
      /^\/api\/shared\/([^/]+)(?:\/(unlock)|\/views\/([^/]+)(\/records)?)?$/
    );
    if (sharedPath) {
      const token = sharedPath[1] ?? '';
      const link = shared[token];
      if (!link) return problem('NOT_FOUND', 404);
      if (link.refuse)
        return problem(link.refuse, link.refuse === 'SHARE_DOMAIN_NOT_ALLOWED' ? 403 : 401);
      if (sharedPath[2]) {
        if (body.password !== link.password) return problem('SHARE_PASSWORD_INCORRECT', 401);
        unlocked.add(token);
        return json(null, 204);
      }
      if (link.password !== undefined && !unlocked.has(token)) {
        return problem('SHARE_PASSWORD_REQUIRED', 401);
      }
      if (!sharedPath[3]) return json(link.share);
      const view = link.views[sharedPath[3]];
      if (!view) return problem('NOT_FOUND', 404);
      if (!sharedPath[4]) return json(view.view);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return json({
        records: view.records.slice(offset, offset + limit),
        offset,
        total: view.records.length,
      });
    }
    const viewId = at(/^\/api\/views\/([^/]+)$/);
    const view = viewId ? find(views, viewId) : undefined;
    if (view && method === 'PATCH') {
      Object.assign(view, body);
      return json(view);
    }
    if (path.match(/^\/api\/tables\/[^/]+\/records\/query$/)) {
      return json({ records: [], offset: 0, total: 0, nextCursor: null });
    }
    throw new Error(`fake API: unexpected ${method} ${path}`);
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    calls,
    signIn,
    notifications,
    notices,
    tokens,
    oauthApps,
    authorizations,
    decisions,
    usage,
    billing,
    ai,
    aiSaves,
    audit,
    aiTest,
    baseUsageWarnings,
    workspaces,
    bases,
    tables,
    views,
    sections,
    members,
    invitations,
    baseCollaborators,
    previews,
    shares,
    shared,
  };
}
