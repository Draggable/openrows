import { describe, expect, it } from 'vitest';
import {
  createShareSchema,
  emailDomain,
  emailDomainAllowed,
  MAX_SHARE_DOMAINS,
  MAX_SHARE_EMBED_ORIGINS,
  shareDomainSchema,
  sharedRecordsQuerySchema,
  sharedViewShape,
  shareEmbedOriginSchema,
  shareFrameAncestors,
} from './share.js';

describe('share link embed origins (#99)', () => {
  it('normalizes https origins of domain names', () => {
    expect(shareEmbedOriginSchema.parse(' https://Example.COM/ ')).toBe('https://example.com');
    expect(shareEmbedOriginSchema.parse('https://intranet.example.org:8443')).toBe(
      'https://intranet.example.org:8443'
    );
    expect(shareEmbedOriginSchema.parse('https://example.com:443')).toBe('https://example.com');
    expect(shareEmbedOriginSchema.parse('https://bücher.example')).toBe(
      'https://xn--bcher-kva.example'
    );
  });

  it('refuses anything that is not a bare https origin of a domain', () => {
    for (const bad of [
      'http://example.com',
      'example.com',
      '//example.com',
      'https://*.example.com',
      'https://example.com/page',
      'https://example.com/?a=1',
      'https://example.com#x',
      'https://user:pw@example.com',
      'https://10.0.0.1',
      'https://[::1]',
      'https://localhost',
      "https://example.com 'unsafe-inline'",
      'https://example.com; script-src *',
      'https://example.com,https://evil.com',
      "'self'",
      '*',
      'data:',
      'javascript:alert(1)',
      '',
    ]) {
      expect(shareEmbedOriginSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('dedupes and caps the list', () => {
    const parsed = createShareSchema.parse({
      embedOrigins: ['https://a.com', 'https://A.com/', 'https://b.com'],
    });
    expect(parsed.embedOrigins).toEqual(['https://a.com', 'https://b.com']);
    const many = Array.from({ length: MAX_SHARE_EMBED_ORIGINS + 1 }, (_, i) => `https://d${i}.com`);
    expect(createShareSchema.safeParse({ embedOrigins: many }).success).toBe(false);
  });

  it('frames restricted links only when their maker allowed it', () => {
    const base = {
      embedOrigins: ['https://a.com'],
      allowRestrictedEmbed: false,
      hasPassword: false,
      allowedDomains: [] as string[],
    };
    expect(shareFrameAncestors(base)).toEqual(['https://a.com']);
    expect(shareFrameAncestors({ ...base, hasPassword: true })).toEqual([]);
    expect(shareFrameAncestors({ ...base, allowedDomains: ['a.com'] })).toEqual([]);
    expect(shareFrameAncestors({ ...base, hasPassword: true, allowRestrictedEmbed: true })).toEqual(
      ['https://a.com']
    );
    expect(shareFrameAncestors({ ...base, embedOrigins: [] })).toEqual([]);
  });
});

describe('share link email domains (#98)', () => {
  it('normalizes domains and refuses wildcards, addresses, URLs and IPs', () => {
    expect(shareDomainSchema.parse(' Example.COM ')).toBe('example.com');
    expect(shareDomainSchema.parse('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    for (const bad of [
      '*.example.com',
      '@example.com',
      'a@example.com',
      'https://example.com',
      'example.com/',
      'example',
      '-example.com',
      'example-.com',
      'exa mple.com',
      '10.0.0.1',
      '',
    ]) {
      expect(shareDomainSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('dedupes and caps the list', () => {
    const parsed = createShareSchema.parse({ allowedDomains: ['A.com', 'a.com', 'b.com'] });
    expect(parsed.allowedDomains).toEqual(['a.com', 'b.com']);
    const many = Array.from({ length: MAX_SHARE_DOMAINS + 1 }, (_, i) => `d${i}.com`);
    expect(createShareSchema.safeParse({ allowedDomains: many }).success).toBe(false);
  });

  it('matches the exact domain after the last @ of a verified address only', () => {
    const allowed = ['example.com'];
    const ok = (email: string, emailVerified = true) =>
      emailDomainAllowed({ email, emailVerified }, allowed);
    expect(ok('ann@example.com')).toBe(true);
    expect(ok('Ann@EXAMPLE.com')).toBe(true);
    expect(ok('ann@example.com', false)).toBe(false);
    expect(ok('eve@evil-example.com')).toBe(false);
    expect(ok('eve@notexample.com')).toBe(false);
    expect(ok('eve@sub.example.com')).toBe(false);
    expect(ok('eve@example.com.evil.org')).toBe(false);
    expect(ok('"eve@example.com"@evil.org')).toBe(false);
    expect(ok('example.com')).toBe(false);
    expect(ok('eve@')).toBe(false);
    expect(emailDomainAllowed(null, allowed)).toBe(false);
    expect(emailDomainAllowed({ email: null, emailVerified: true }, allowed)).toBe(false);
    expect(emailDomain('a@b@Example.com')).toBe('example.com');
  });
});

describe('sharedViewShape (#120)', () => {
  const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const TABLE = id(100);
  const fields = [
    { id: id(1), type: 'singleLineText', isPrimary: true },
    { id: id(2), type: 'longText', isPrimary: false },
    { id: id(3), type: 'singleSelect', isPrimary: false, options: { choices: [] } },
    { id: id(4), type: 'singleLineText', isPrimary: false },
    { id: id(5), type: 'date', isPrimary: false },
    { id: id(6), type: 'attachment', isPrimary: false },
    { id: id(7), type: 'link', isPrimary: false, options: { linkedTableId: TABLE } },
    { id: id(8), type: 'link', isPrimary: false, options: { linkedTableId: id(101) } },
  ];
  const shape = (type: string, config: unknown) => sharedViewShape({ type, config }, fields, TABLE);

  it('shows a grid’s unhidden fields', () => {
    expect(shape('grid', { grid: { hiddenFields: [id(4), id(1)] } }).fieldIds).toEqual(
      fields.filter((f) => f.id !== id(4)).map((f) => f.id)
    );
  });

  it('shows a kanban’s title, stack, cover and cards; defaults to the first three', () => {
    const saved = shape('kanban', {
      kanban: { stackFieldId: id(3), cardFields: [id(2), id(1), id(99)], coverFieldId: id(6) },
    });
    expect(saved.fieldIds.sort()).toEqual([id(1), id(2), id(3), id(6)].sort());
    expect(saved.kanban?.cardFields).toEqual([id(2)]);
    const defaults = shape('kanban', { kanban: { stackFieldId: id(3) } });
    expect(defaults.kanban?.cardFields).toEqual([id(2), id(4), id(5)]);
    // A stack or cover that can't serve is dropped, and nothing else shows.
    const bad = shape('kanban', { kanban: { stackFieldId: id(4), coverFieldId: id(2) } });
    expect(bad.kanban).toMatchObject({ stackFieldId: null, coverFieldId: null });
  });

  it('shows a calendar’s and timeline’s dates; self links only as structure', () => {
    const cal = shape('calendar', {
      calendar: { dateFields: [{ startFieldId: id(5) }, { startFieldId: id(4) }] },
    });
    expect(cal.fieldIds).toEqual([id(1), id(5)]);
    expect(cal.dateFields).toEqual([{ startFieldId: id(5) }]);
    const tl = shape('timeline', {
      timeline: { startFieldId: id(5), groupFieldId: id(3), dependencyFieldId: id(7) },
    });
    expect(tl.fieldIds).toEqual([id(1), id(5), id(3)]);
    expect(tl.links).toEqual([id(7)]);
    // A link to another table is no dependency.
    expect(shape('timeline', { timeline: { dependencyFieldId: id(8) } }).links).toEqual([]);
    const list = shape('list', { list: { parentFieldId: id(7), rowFields: [id(2)] } });
    expect(list.fieldIds).toEqual([id(1), id(2)]);
    expect(list.links).toEqual([id(7)]);
  });

  it('takes a date window only whole and forward', () => {
    const ok = (q: Record<string, string>) => sharedRecordsQuerySchema.safeParse(q).success;
    expect(ok({ from: '2026-03-01', to: '2026-03-31' })).toBe(true);
    expect(ok({ from: '2026-03-01' })).toBe(false);
    expect(ok({ from: '2026-03-31', to: '2026-03-01' })).toBe(false);
    expect(ok({ from: '2026-01-01', to: '2027-06-01' })).toBe(false);
    expect(ok({ from: '2026-03-01', to: '2026-03-02', filter: 'x' })).toBe(false);
  });
});
