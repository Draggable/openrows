import { describe, expect, it } from 'vitest';
import { ConfigError } from '../config.js';
import { sendTestEmail } from './send-test.js';
import { testEmail } from './templates.js';

describe('sendTestEmail (#136)', () => {
  it('refuses to run without SMTP_HOST', async () => {
    await expect(sendTestEmail({}, 'ops@example.com')).rejects.toThrow(ConfigError);
    await expect(sendTestEmail({}, 'ops@example.com')).rejects.toMatchObject({
      issues: ['SMTP_HOST: not set, so mail is logged, not sent'],
    });
  });

  it('refuses a recipient that is not one address', async () => {
    for (const to of ['nobody', 'a@example.com, b@example.com', 'a@example.com\r\nBcc: b@x.io']) {
      await expect(sendTestEmail({ SMTP_HOST: '127.0.0.1' }, to)).rejects.toMatchObject({
        issues: [expect.stringMatching(/^recipient: .* is not an email address$/)],
      });
    }
  });

  it("refuses the worker's production rules first", async () => {
    await expect(
      sendTestEmail({ NODE_ENV: 'production', SMTP_HOST: 'mail.example.com' }, 'ops@example.com')
    ).rejects.toThrow(ConfigError);
  });
});

describe('testEmail', () => {
  it('names the app and the time, with a text alternative', () => {
    const mail = testEmail({
      appUrl: 'https://app.example.com',
      sentAt: new Date('2026-10-28T12:00:00Z'),
    });
    expect(mail.subject).toMatch(/test email$/);
    expect(mail.html).toContain('https://app.example.com');
    expect(mail.text).toContain('2026-10-28T12:00:00.000Z');
  });
});
