import { describe, expect, it } from 'vitest';
import { ACTIONS, type Action, RESOURCE_KINDS, roleAllows } from './authz.js';
import { USER_ROLES } from './constants/index.js';

describe('authz vocabulary', () => {
  it('lets each role do everything the role below it can', () => {
    for (const action of Object.keys(ACTIONS) as Action[]) {
      const allowed = USER_ROLES.map((role) => roleAllows(role, action));
      // Once a role is refused, every lower role is refused too.
      expect(allowed).toEqual([...allowed].sort((a, b) => Number(b) - Number(a)));
      expect(roleAllows('owner', action)).toBe(true);
    }
  });

  it('follows the Airtable ladder', () => {
    expect(roleAllows('read_only', 'record:read')).toBe(true);
    expect(roleAllows('read_only', 'comment:create')).toBe(false);
    expect(roleAllows('commenter', 'comment:create')).toBe(true);
    expect(roleAllows('commenter', 'record:update')).toBe(false);
    expect(roleAllows('editor', 'record:update')).toBe(true);
    expect(roleAllows('editor', 'field:create')).toBe(false);
    expect(roleAllows('creator', 'base:create')).toBe(true);
    expect(roleAllows('creator', 'workspace:update')).toBe(false);
  });

  it('checks every action against a known resource kind', () => {
    for (const { on } of Object.values(ACTIONS)) expect(RESOURCE_KINDS).toContain(on);
  });
});
