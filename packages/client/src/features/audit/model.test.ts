import type { AuditEvent } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { actorText, filterQuery, summaryLines, targetText, unavailable } from './model';

const base: AuditEvent = {
  id: '01a18544-9433-7db5-b2be-37e989323f8d',
  at: '2026-10-25T10:00:00.000Z',
  action: 'share.create',
  actor: { kind: 'token', userId: null, email: 'ada@example.test' },
  ip: null,
  userAgent: null,
  target: { type: 'audit_stream', id: 'x', name: null },
  summary: { before: { role: 'editor' }, after: { role: 'owner', events: ['a', 'b'], on: true } },
};

describe('the audit log model', () => {
  it('turns the filter form into the query, `to` inclusive', () => {
    expect(filterQuery({ category: '', q: '  ', from: '', to: '' })).toEqual({});
    const q = filterQuery({ category: 'member', q: ' bob ', from: '2026-10-01', to: '2026-10-01' });
    expect(q['action']).toBe('member');
    expect(q['q']).toBe('bob');
    expect(new Date(q['to'] ?? '').getTime() - new Date(q['from'] ?? '').getTime()).toBe(
      86_400_000
    );
  });

  it('describes the actor, the target and the summary', () => {
    expect(actorText(base)).toBe('ada@example.test (access token)');
    expect(actorText({ ...base, actor: { kind: 'system', userId: null, email: null } })).toBe(
      'OpenRows'
    );
    expect(targetText(base)).toBe('audit stream x');
    expect(summaryLines(base)).toEqual(['role: editor → owner', 'events: a, b', 'on: true']);
  });

  it('tells the edition from the plan', () => {
    expect(unavailable(new ApiError(404, 'Not found'))).toBe('edition');
    expect(unavailable(new ApiError(403, 'Plan', undefined, 'PLAN_FEATURE_REQUIRED'))).toBe('plan');
    expect(unavailable(new Error('x'))).toBe('error');
  });
});
