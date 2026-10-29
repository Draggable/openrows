import { describe, expect, it } from 'vitest';
import { escapeHtml, html, safeUrl } from './html.js';
import {
  DIGEST_MAX_ITEMS_PER_RECORD,
  DIGEST_MAX_RECORDS,
  invitationEmail,
  legalNoticeEmail,
  NOTIFICATION_EMAIL_MAX_ITEMS,
  notificationDigestEmail,
  notificationEmail,
} from './templates.js';

describe('email HTML', () => {
  it('escapes every interpolation unless it is an html fragment', () => {
    const name = '<img src=x onerror=alert(1)>';
    expect(html`<b>${name}</b>`.value).toBe('<b>&lt;img src=x onerror=alert(1)&gt;</b>');
    expect(html`<p>${html`<b>${'&'}</b>`}</p>`.value).toBe('<p><b>&amp;</b></p>');
    expect(escapeHtml(`"'`)).toBe('&quot;&#39;');
  });

  it('only allows http(s) links', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('https://app.openrows.io/x')).toBe('https://app.openrows.io/x');
  });

  it('renders the invitation with hostile names escaped (M3)', () => {
    const mail = invitationEmail({
      inviterName: 'Eve <script>alert(1)</script>',
      workspaceName: '"><a href="https://evil.example">Click</a>',
      acceptUrl: 'https://app.openrows.io/invitations/abc?x=1&y=2',
    });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<a href="https://evil.example">');
    expect(mail.html).toContain('Eve &lt;script&gt;');
    expect(mail.html).toContain('href="https://app.openrows.io/invitations/abc?x=1&amp;y=2"');
    expect(mail.text).toContain('https://app.openrows.io/invitations/abc?x=1&y=2');
    expect(() =>
      invitationEmail({ inviterName: 'a', workspaceName: 'b', acceptUrl: 'javascript:alert(1)' })
    ).toThrow();
  });

  it('frames every email in the brand: rose top bar, mark, wordmark, rose button (#140)', () => {
    const mail = invitationEmail({
      inviterName: 'Ada',
      workspaceName: 'Acme',
      acceptUrl: 'https://app.openrows.io/invite/abc',
    });
    expect(mail.html).toContain('border-top: 3px solid #E22651');
    expect(mail.html).toContain('src="cid:logo@openrows"');
    expect(mail.html).toMatch(/background: #E22651; color: #FFFFFF;[^>]*>Accept invitation</);
    // No coloured left border anywhere (DESIGN.md §7).
    expect(mail.html).not.toMatch(/border-left:/);
  });
});

describe('notification email (#93)', () => {
  const links = {
    recordUrl: 'https://app.openrows.io/b/x/y?record=1&comment=2',
    unsubscribeUrl: 'https://app.openrows.io/email/unsubscribe?token=t',
    preferencesUrl: 'https://app.openrows.io/settings',
  };

  it('escapes the record name, actor and excerpt, and links settings and unsubscribe', () => {
    const mail = notificationEmail({
      recordName: '<img src=x onerror=alert(1)>',
      baseName: 'Base "B"',
      items: [
        { kind: 'mention', actorName: 'Eve <b>', excerpt: '<script>x</script>', fieldName: null },
      ],
      ...links,
    });
    expect(mail.subject).toBe('Eve <b> mentioned you on <img src=x onerror=alert(1)>');
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(mail.html).toContain('href="https://app.openrows.io/b/x/y?record=1&amp;comment=2"');
    expect(mail.html).toContain('href="https://app.openrows.io/email/unsubscribe?token=t"');
    expect(mail.text).toContain('Unsubscribe: https://app.openrows.io/email/unsubscribe?token=t');
  });

  it('coalesces several notifications, listing up to the cap', () => {
    const items = Array.from({ length: NOTIFICATION_EMAIL_MAX_ITEMS + 2 }, (_, i) => ({
      kind: i % 2 ? ('reply' as const) : ('assigned' as const),
      actorName: `P${i}`,
      excerpt: i % 2 ? `note ${i}` : null,
      fieldName: i % 2 ? null : 'Owner',
    }));
    const mail = notificationEmail({ recordName: '', baseName: 'B', items, ...links });
    expect(mail.subject).toBe(`${items.length} new notifications on Unnamed record`);
    expect(mail.text).toContain('- P0 added you to Owner');
    expect(mail.text).toContain('- P1 replied: "note 1"');
    expect(mail.text).toContain('and 2 more');
    expect(() =>
      notificationEmail({
        recordName: 'R',
        baseName: 'B',
        items,
        ...links,
        recordUrl: 'javascript:x',
      })
    ).toThrow();
  });
});

describe('notification digest (#122)', () => {
  const links = {
    unsubscribeUrl: 'https://app.openrows.io/email/unsubscribe?token=t',
    preferencesUrl: 'https://app.openrows.io/settings',
  };
  const record = (n: number, items = 1) => ({
    recordName: `Rec <${n}>`,
    tableName: 'Tasks',
    baseName: 'Ops & co',
    recordUrl: `https://app.openrows.io/b/b/t?record=${n}`,
    items: Array.from({ length: items }, () => ({
      kind: 'mention' as const,
      actorName: 'Eve <b>',
      excerpt: '<script>alert(1)</script>',
      fieldName: null,
    })),
  });

  it('groups by record, escapes every name and excerpt, and counts everything', () => {
    const mail = notificationDigestEmail({
      frequency: 'daily',
      records: [record(1, 2), record(2)],
      ...links,
    });
    expect(mail.subject).toBe('Your daily OpenRows digest: 3 new notifications');
    expect(mail.html).toContain('Rec &lt;1&gt;');
    expect(mail.html).toContain('Ops &amp; co · Tasks');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('Eve <b>');
    expect(mail.html).toContain('href="https://app.openrows.io/b/b/t?record=2"');
    expect(mail.text).toContain('Rec <1> (Ops & co · Tasks)');
    expect(mail.text).toContain('Unsubscribe: https://app.openrows.io/email/unsubscribe?token=t');
  });

  it('caps records and items per record, saying how many more', () => {
    const many = Array.from({ length: DIGEST_MAX_RECORDS + 2 }, (_, i) =>
      record(i, i === 0 ? DIGEST_MAX_ITEMS_PER_RECORD + 3 : 1)
    );
    const mail = notificationDigestEmail({ frequency: 'hourly', records: many, ...links });
    expect(mail.subject).toContain(`${DIGEST_MAX_RECORDS + 2 + DIGEST_MAX_ITEMS_PER_RECORD + 2}`);
    expect(mail.text).toContain('- and 3 more');
    expect(mail.text).toContain('and 2 more records with news');
    expect(mail.html).not.toContain(`Rec &lt;${DIGEST_MAX_RECORDS}&gt;`);
  });

  it('refuses script links and an empty digest', () => {
    expect(() =>
      notificationDigestEmail({
        frequency: 'daily',
        records: [{ ...record(1), recordUrl: 'javascript:alert(1)' }],
        ...links,
      })
    ).toThrow();
    expect(() => notificationDigestEmail({ frequency: 'daily', records: [], ...links })).toThrow();
  });
});

describe('service notice email (#78)', () => {
  const notice = {
    kind: 'terms' as const,
    title: 'Terms <update>',
    summary: 'First <b>paragraph</b>.\n\nSecond one.',
    url: 'https://openrows.io/terms',
    effective: 'December 1, 2026',
    appUrl: 'https://app.openrows.io',
  };

  it('escapes the operator text, says when it takes effect and links the details', () => {
    const m = legalNoticeEmail(notice);
    expect(m.subject).toBe('Terms <update>');
    expect(m.html).toContain('Terms &lt;update&gt;');
    expect(m.html).not.toContain('<b>paragraph</b>');
    expect(m.html).toContain('<p>First &lt;b&gt;paragraph&lt;/b&gt;.</p>');
    expect(m.html).toContain('<p>Second one.</p>');
    expect(m.html).toContain('href="https://openrows.io/terms"');
    expect(m.text).toContain('This takes effect on December 1, 2026. If you keep using');
    expect(m.text).toContain('Read the details: https://openrows.io/terms');
    expect(m.text).toContain('https://app.openrows.io');
  });

  it('tells subscribers they can change or cancel before a price change', () => {
    expect(legalNoticeEmail({ ...notice, kind: 'price' }).text).toContain('change or cancel');
    expect(legalNoticeEmail({ ...notice, kind: 'service' }).text).toContain(
      'This takes effect on December 1, 2026.\n'
    );
  });

  it('refuses a details link that is not http(s)', () => {
    expect(() => legalNoticeEmail({ ...notice, url: 'javascript:alert(1)' })).toThrow();
  });
});
