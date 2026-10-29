import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createTransport } from 'nodemailer';
import type { Config } from '../config.js';
import type { Logger } from '../lib/logger.js';
import { EMAIL_LOGO_PNG_BASE64 } from './logo.js';
import { EMAIL_LOGO_CID, type EmailContent } from './templates.js';

export interface EmailMessage extends EmailContent {
  to: string;
  /** Extra headers (List-Unsubscribe on notification emails). */
  headers?: Record<string, string>;
}

/** Where the app's own mail goes. Sign-up, verification and reset mail is sent by Keycloak. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
  /** False when messages are dropped (no SMTP), so callers can say the mail didn't go out. */
  readonly delivers?: boolean;
}

/**
 * nodemailer options for one send. nodemailer resolves `host` with DNS queries (dns.resolve4/6)
 * and only falls back to the OS resolver, so /etc/hosts entries lose to whatever DNS answers (the
 * dev and CI stacks map `mailpit` to 127.0.0.1 that way, and a resolver can still answer for the
 * name). So we resolve like the rest of Node (`dns.lookup`, getaddrinfo), connect to that
 * address, and keep the name for TLS (SNI and the certificate check).
 */
export function smtpOptions(smtp: NonNullable<Config['smtp']>, address: string) {
  return {
    host: address,
    port: smtp.port,
    secure: smtp.secure,
    // SMTP_SECURE=starttls: refuse to go on (and send credentials) if STARTTLS isn't offered.
    requireTLS: smtp.requireTls,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
    tls: isIP(smtp.host) ? undefined : { servername: smtp.host },
    // Fail instead of hanging when the relay is unreachable.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  };
}

/** What the relay said about one message (the send test prints it). */
export interface SmtpReceipt {
  messageId: string;
  /** The relay's last reply, e.g. `250 OK id=1abc-…`. */
  response: string;
  accepted: string[];
  rejected: string[];
}

/** The inline images a message's HTML refers to: the rose mark of the layout. */
export function inlineAttachments(html: string) {
  return html.includes(`cid:${EMAIL_LOGO_CID}`)
    ? [
        {
          filename: 'openrows.png',
          content: Buffer.from(EMAIL_LOGO_PNG_BASE64, 'base64'),
          contentType: 'image/png',
          cid: EMAIL_LOGO_CID,
          contentDisposition: 'inline' as const,
        },
      ]
    : [];
}

/** Sends one message over SMTP and returns the relay's answer. */
export async function sendSmtp(
  smtp: NonNullable<Config['smtp']>,
  from: string,
  m: EmailMessage
): Promise<SmtpReceipt> {
  const { address } = await lookup(smtp.host);
  const info = await createTransport(smtpOptions(smtp, address)).sendMail({
    from,
    to: m.to,
    subject: m.subject,
    html: m.html,
    text: m.text,
    ...(m.headers ? { headers: m.headers } : {}),
    attachments: inlineAttachments(m.html),
  });
  const addresses = (list: (string | { address: string })[]) =>
    list.map((a) => (typeof a === 'string' ? a : a.address));
  return {
    messageId: info.messageId,
    response: info.response,
    accepted: addresses(info.accepted),
    rejected: addresses(info.rejected),
  };
}

/** SMTP via nodemailer: Mailpit in development, the provider's relay in production. */
export function smtpTransport(smtp: NonNullable<Config['smtp']>, from: string): EmailTransport {
  return {
    async send(m) {
      await sendSmtp(smtp, from, m);
    },
  };
}

/** Logs instead of sending (no SMTP configured). Never logs the body, which can hold links. */
export function logTransport(logger: Logger): EmailTransport {
  return {
    delivers: false,
    async send(m) {
      logger.warn({ to: m.to, subject: m.subject }, 'SMTP is not configured; email not sent');
    },
  };
}

/** Collects messages in memory, for tests. */
export function memoryTransport(): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(m) {
      sent.push(m);
    },
  };
}

export function createEmailTransport(config: Config, logger: Logger): EmailTransport {
  return config.smtp ? smtpTransport(config.smtp, config.mailFrom) : logTransport(logger);
}
