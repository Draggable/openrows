import {
  ACTION_SCOPES,
  ACTIONS,
  type Action,
  BASE_ROLES,
  roleAllows,
  TOKEN_SCOPES,
  type TokenScope,
  USER_ROLES,
} from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/sessions.js';
import type { AppError } from '../lib/errors.js';
import {
  assertAllowed,
  authorize,
  effectiveRole,
  principalMay,
  type ResolvedResource,
} from './policy.js';

const principal = (isSystemAdmin = false) =>
  ({ user: { id: 'u1', isSystemAdmin }, session: {} }) as unknown as Principal;

const resource = (over: Partial<ResolvedResource> = {}): ResolvedResource => ({
  kind: 'base',
  id: 'b1',
  workspaceId: 'w1',
  baseId: 'b1',
  workspaceRole: null,
  baseRole: null,
  ...over,
});

describe('effectiveRole', () => {
  it('uses the workspace role when there is no override', () => {
    for (const role of USER_ROLES)
      expect(effectiveRole(resource({ workspaceRole: role }))).toBe(role);
  });

  it('takes the higher of the workspace and base roles (#91: a base role never lowers)', () => {
    expect(effectiveRole(resource({ workspaceRole: 'read_only', baseRole: 'creator' }))).toBe(
      'creator'
    );
    expect(effectiveRole(resource({ workspaceRole: 'creator', baseRole: 'read_only' }))).toBe(
      'creator'
    );
    expect(effectiveRole(resource({ workspaceRole: 'editor', baseRole: 'editor' }))).toBe('editor');
  });

  it('keeps workspace owners owners in every base', () => {
    for (const baseRole of BASE_ROLES) {
      expect(effectiveRole(resource({ workspaceRole: 'owner', baseRole }))).toBe('owner');
    }
  });

  it('gives base-only collaborators their override inside the base, nothing on the workspace', () => {
    expect(effectiveRole(resource({ baseRole: 'editor' }))).toBe('editor');
    expect(
      effectiveRole(resource({ kind: 'workspace', baseId: null, baseRole: 'editor' }))
    ).toBeNull();
  });
});

describe('authorize', () => {
  it('refuses anonymous callers before anything else', () => {
    expect(authorize(null, 'base:read', resource({ workspaceRole: 'owner' }))).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('answers not_found for a missing resource and for one the user has no role on (L2)', () => {
    expect(authorize(principal(), 'base:read', null)).toEqual({
      allowed: false,
      reason: 'not_found',
    });
    expect(authorize(principal(), 'base:delete', resource())).toEqual({
      allowed: false,
      reason: 'not_found',
    });
  });

  it('follows the role ladder for every action and role', () => {
    for (const action of Object.keys(ACTIONS) as Action[]) {
      const kind = ACTIONS[action].on;
      for (const role of USER_ROLES) {
        const r = resource({
          kind,
          baseId: kind === 'workspace' ? null : 'b1',
          workspaceRole: role,
        });
        const expected = roleAllows(role, action)
          ? { allowed: true, role }
          : { allowed: false, reason: 'forbidden' };
        expect(authorize(principal(), action, r), `${role} ${action}`).toEqual(expected);
      }
    }
  });

  it('gives system admins no tenant access (C1)', () => {
    expect(authorize(principal(true), 'base:read', resource())).toEqual({
      allowed: false,
      reason: 'not_found',
    });
  });

  it('throws when an action is checked against the wrong kind of resource', () => {
    expect(() =>
      authorize(principal(), 'record:update', resource({ workspaceRole: 'owner' }))
    ).toThrow(/record:update is checked on a table/);
  });
});

describe('authorize in a suspended workspace (#134)', () => {
  it('allows what a read-only member may do, and nothing else, whatever the role', () => {
    const suspended = resource({
      kind: 'base',
      baseId: 'b',
      workspaceRole: 'owner',
      suspended: true,
    });
    expect(authorize(principal(), 'base:read', suspended)).toEqual({
      allowed: true,
      role: 'owner',
    });
    expect(authorize(principal(), 'base:update', suspended)).toEqual({
      allowed: false,
      reason: 'suspended',
    });
    expect(() => assertAllowed(authorize(principal(), 'table:create', suspended))).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_SUSPENDED' })
    );
    // Someone with no role there still gets 404.
    const stranger = resource({ kind: 'base', baseId: 'b', suspended: true });
    expect(authorize(principal(), 'base:update', stranger)).toEqual({
      allowed: false,
      reason: 'not_found',
    });
  });
});

describe('assertAllowed', () => {
  it('maps refusals to 401, 404 and 403', () => {
    const status = (reason: 'unauthenticated' | 'not_found' | 'forbidden') => {
      try {
        assertAllowed({ allowed: false, reason });
      } catch (err) {
        return (err as AppError).status;
      }
    };
    expect([status('unauthenticated'), status('not_found'), status('forbidden')]).toEqual([
      401, 404, 403,
    ]);
    expect(assertAllowed({ allowed: true, role: 'editor' })).toBe('editor');
  });
});

describe('authorize with a personal access token (#102)', () => {
  const tokenPrincipal = (
    scopes: readonly TokenScope[],
    grants: { workspaceIds?: string[]; baseIds?: string[] } = { workspaceIds: ['w1'] }
  ) =>
    ({
      user: { id: 'u1', isSystemAdmin: false },
      session: {},
      token: {
        id: 't1',
        scopes,
        workspaceIds: grants.workspaceIds ?? [],
        baseIds: grants.baseIds ?? [],
      },
    }) as unknown as Principal;

  const on = (action: Action, role: (typeof USER_ROLES)[number]) => {
    const kind = ACTIONS[action].on;
    return resource({ kind, baseId: kind === 'workspace' ? null : 'b1', workspaceRole: role });
  };

  it('allows exactly role ∩ scope, for every scope, action and role', () => {
    for (const scope of TOKEN_SCOPES) {
      for (const action of Object.keys(ACTIONS) as Action[]) {
        for (const role of USER_ROLES) {
          const expected = !roleAllows(role, action)
            ? { allowed: false, reason: 'forbidden' }
            : ACTION_SCOPES[action] === scope
              ? { allowed: true, role }
              : { allowed: false, reason: 'forbidden' };
          expect(
            authorize(tokenPrincipal([scope]), action, on(action, role)),
            `${scope} ${action} ${role}`
          ).toEqual(expected);
        }
      }
    }
  });

  it('never exceeds the role, even with every scope', () => {
    for (const action of Object.keys(ACTIONS) as Action[]) {
      for (const role of USER_ROLES) {
        const d = authorize(tokenPrincipal(TOKEN_SCOPES), action, on(action, role));
        if (d.allowed) expect(roleAllows(role, action), `${role} ${action}`).toBe(true);
        else if (ACTION_SCOPES[action] !== null) expect(roleAllows(role, action)).toBe(false);
      }
    }
  });

  it('keeps session-only actions (null scope) to sessions', () => {
    const sessionOnly = (Object.keys(ACTIONS) as Action[]).filter((a) => !ACTION_SCOPES[a]);
    expect(sessionOnly).toEqual(
      expect.arrayContaining([
        'workspace:update',
        'workspace:delete',
        'workspace:manage_members',
        'base:delete',
        'base:manage_members',
        'base:share',
        'base:snapshot',
        'view:share',
        'view:lock',
        'record:purge',
      ])
    );
    for (const action of sessionOnly) {
      expect(authorize(tokenPrincipal(TOKEN_SCOPES), action, on(action, 'owner')), action).toEqual({
        allowed: false,
        reason: 'forbidden',
      });
      expect(authorize(principal(), action, on(action, 'owner')).allowed, action).toBe(true);
    }
  });

  it('answers not_found outside the grants: other workspaces, and bases not granted', () => {
    const all = TOKEN_SCOPES;
    const elsewhere = tokenPrincipal(all, { workspaceIds: ['w2'] });
    expect(authorize(elsewhere, 'base:read', resource({ workspaceRole: 'owner' }))).toEqual({
      allowed: false,
      reason: 'not_found',
    });
    const oneBase = tokenPrincipal(all, { baseIds: ['b1'] });
    expect(authorize(oneBase, 'base:read', resource({ workspaceRole: 'owner' }))).toEqual({
      allowed: true,
      role: 'owner',
    });
    expect(
      authorize(oneBase, 'base:read', resource({ id: 'b2', baseId: 'b2', workspaceRole: 'owner' }))
    ).toEqual({ allowed: false, reason: 'not_found' });
    // A base grant doesn't reach the workspace itself.
    expect(
      authorize(
        oneBase,
        'workspace:read',
        resource({ kind: 'workspace', id: 'w1', baseId: null, workspaceRole: 'owner' })
      )
    ).toEqual({ allowed: false, reason: 'not_found' });
    // No role still wins over everything: not_found.
    expect(authorize(tokenPrincipal(all), 'base:read', resource())).toEqual({
      allowed: false,
      reason: 'not_found',
    });
  });

  it("uses a route's narrower scope when given", () => {
    const p = tokenPrincipal(['schema.bases:read']);
    const r = resource({ workspaceRole: 'owner' });
    expect(authorize(p, 'base:read', r).allowed).toBe(true);
    expect(authorize(p, 'base:read', r, 'data.records:read').allowed).toBe(false);
    expect(authorize(p, 'base:read', r, null).allowed).toBe(false);
    expect(authorize(principal(), 'base:read', r, null).allowed).toBe(true);
  });

  it('refuses every token on a workspace whose policy turned tokens off (#160)', () => {
    const p = tokenPrincipal(TOKEN_SCOPES);
    const off = resource({ workspaceRole: 'owner', tokensAllowed: false });
    expect(authorize(p, 'base:read', off)).toEqual({ allowed: false, reason: 'policy' });
    expect(authorize(p, 'base:update', off)).toEqual({ allowed: false, reason: 'policy' });
    // Signed-in sessions aren't affected; outside the token's grants it's still not_found.
    expect(authorize(principal(), 'base:read', off).allowed).toBe(true);
    const elsewhere = tokenPrincipal(TOKEN_SCOPES, { workspaceIds: ['w2'] });
    expect(authorize(elsewhere, 'base:read', off)).toEqual({ allowed: false, reason: 'not_found' });
    expect(authorize(p, 'base:read', resource({ tokensAllowed: false }))).toEqual({
      allowed: false,
      reason: 'not_found',
    });
    expect(() => assertAllowed(authorize(p, 'base:read', off))).toThrow(
      expect.objectContaining({ code: 'POLICY_RESTRICTED' })
    );
  });

  it('principalMay checks the token scopes after the role', () => {
    const p = tokenPrincipal(TOKEN_SCOPES);
    expect(principalMay(p, 'owner', 'view:lock')).toBe(false);
    expect(principalMay(principal(), 'owner', 'view:lock')).toBe(true);
    expect(principalMay(p, 'owner', 'record:update')).toBe(true);
    expect(principalMay(p, 'read_only', 'record:update')).toBe(false);
  });
});
