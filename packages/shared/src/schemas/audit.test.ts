import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_SUMMARY_MAX_CHARS,
  AUDIT_SUMMARY_MAX_KEYS,
  auditCategory,
  auditListQuerySchema,
  sanitizeAuditValues,
} from './audit.js';

describe('sanitizeAuditValues', () => {
  it('keeps primitives and short lists of them', () => {
    expect(
      sanitizeAuditValues({ name: 'Acme', count: 3, on: true, none: null, roles: ['a', 1] })
    ).toEqual({ name: 'Acme', count: 3, on: true, none: null, roles: ['a', 1] });
  });

  it('drops credential-like keys, objects and non-finite numbers, and cuts strings', () => {
    const out = sanitizeAuditValues({
      password: 'hunter2',
      apiKey: 'sk-123',
      token: 'or_pat_x',
      secretRotated: true,
      config: { url: 'https://x' },
      cell: [{ a: 1 }],
      n: Number.NaN,
      long: 'x'.repeat(1000),
    });
    expect(out).toEqual({ cell: [], n: null, long: 'x'.repeat(AUDIT_SUMMARY_MAX_CHARS) });
  });

  it('keeps at most AUDIT_SUMMARY_MAX_KEYS keys', () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeAuditValues(many))).toHaveLength(AUDIT_SUMMARY_MAX_KEYS);
  });
});

describe('audit actions', () => {
  it('are unique `<category>.<verb>` names', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const a of AUDIT_ACTIONS) expect(a).toMatch(/^[a-z_]+\.[a-z_]+$/);
    expect(AUDIT_CATEGORIES).toContain('member');
    expect(auditCategory('member.role_change')).toBe('member');
  });

  it('filter by an action or a category, nothing else', () => {
    expect(auditListQuerySchema.parse({ action: 'member' }).action).toBe('member');
    expect(auditListQuerySchema.parse({ action: 'share.create' }).action).toBe('share.create');
    expect(auditListQuerySchema.safeParse({ action: 'member.nope' }).success).toBe(false);
    expect(auditListQuerySchema.parse({}).limit).toBe(50);
    expect(auditListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });
});
