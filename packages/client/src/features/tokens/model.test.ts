import { describe, expect, it } from 'vitest';
import {
  draftProblem,
  emptyDraft,
  grantSummary,
  isExpired,
  toggle,
  toRequest,
  usageSummary,
  usageTotals,
} from './model';

describe('token form model (#102)', () => {
  it('says what is missing before a token can be created', () => {
    const d = emptyDraft();
    expect(draftProblem(d)).toBe('Name the token.');
    expect(draftProblem({ ...d, name: 'CI' })).toBe('Pick at least one scope.');
    expect(draftProblem({ ...d, name: 'CI', scopes: ['data.records:read'] })).toMatch(/workspace/);
    expect(
      draftProblem({ ...d, name: 'CI', scopes: ['data.records:read'], baseIds: ['b1'] })
    ).toBeNull();
  });

  it('builds the request: scopes in order, bases of whole workspaces dropped', () => {
    const req = toRequest(
      {
        name: '  CI  ',
        scopes: ['schema.bases:read', 'data.records:read'],
        workspaceIds: ['w1'],
        baseIds: ['b1', 'b2'],
        expiresInDays: 30,
      },
      new Map([
        ['b1', 'w1'],
        ['b2', 'w2'],
      ])
    );
    expect(req).toEqual({
      name: 'CI',
      scopes: ['data.records:read', 'schema.bases:read'],
      workspaceIds: ['w1'],
      baseIds: ['b2'],
      expiresInDays: 30,
    });
  });

  it('toggles, summarises grants and tells expired tokens', () => {
    expect(toggle(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggle(['a'], 'a', true)).toEqual(['a']);
    expect(grantSummary({ workspaceIds: ['w'], baseIds: ['a', 'b'] })).toBe('1 workspace, 2 bases');
    expect(isExpired({ expiresAt: '2020-01-01T00:00:00Z' })).toBe(true);
    expect(isExpired({ expiresAt: '2999-01-01T00:00:00Z' })).toBe(false);
  });
});

describe('usage (#104)', () => {
  const usage = (counts: number[]) =>
    counts.map((requests, i) => ({ day: `2026-10-0${i + 1}`, requests }));
  it('sums today and the week', () => {
    expect(usageTotals({ usage: usage([1, 0, 2, 0, 0, 3, 1]) })).toEqual({ today: 1, week: 7 });
    expect(usageSummary({ usage: usage([0, 0, 0, 0, 0, 0, 1]) })).toBe(
      '1 request today · 1 in 7 days'
    );
    expect(usageSummary({ usage: [] })).toBe('0 requests today · 0 in 0 days');
  });
});
