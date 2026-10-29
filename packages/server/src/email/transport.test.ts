import { describe, expect, it } from 'vitest';
import { EMAIL_LOGO_CID, invitationEmail } from './templates.js';
import { inlineAttachments, smtpOptions } from './transport.js';

describe('smtpOptions', () => {
  const smtp = {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    requireTls: false,
    user: 'u',
    password: 'p',
  };

  it('connects to the resolved address and keeps the name for TLS', () => {
    expect(smtpOptions(smtp, '192.0.2.10')).toMatchObject({
      host: '192.0.2.10',
      port: 587,
      secure: false,
      auth: { user: 'u', pass: 'p' },
      tls: { servername: 'smtp.example.com' },
      requireTLS: false,
    });
  });

  it('requires STARTTLS for SMTP_SECURE=starttls (#136)', () => {
    expect(smtpOptions({ ...smtp, requireTls: true }, '192.0.2.10')).toMatchObject({
      secure: false,
      requireTLS: true,
      tls: { servername: 'smtp.example.com' },
    });
  });

  it('sets no TLS server name for an IP host, and no auth without a user', () => {
    const opts = smtpOptions(
      {
        host: '127.0.0.1',
        port: 1025,
        secure: false,
        requireTls: false,
        user: undefined,
        password: undefined,
      },
      '127.0.0.1'
    );
    expect(opts.tls).toBeUndefined();
    expect(opts.auth).toBeUndefined();
  });
});

describe('inlineAttachments', () => {
  it('attaches the rose mark inline when the layout refers to it (#140)', () => {
    const mail = invitationEmail({
      inviterName: 'Ada',
      workspaceName: 'Acme',
      acceptUrl: 'https://app.openrows.io/invite/abc',
    });
    expect(mail.html).toContain(`src="cid:${EMAIL_LOGO_CID}"`);
    const [logo, ...rest] = inlineAttachments(mail.html);
    expect(rest).toEqual([]);
    expect(logo?.cid).toBe(EMAIL_LOGO_CID);
    expect(logo?.contentType).toBe('image/png');
    // A PNG's signature.
    expect(logo?.content.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('attaches nothing to HTML without the mark', () => {
    expect(inlineAttachments('<p>Hi</p>')).toEqual([]);
  });
});
