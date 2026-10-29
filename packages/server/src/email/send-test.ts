import { z } from 'zod';
import { ConfigError, loadWorkerConfig } from '../config.js';
import { testEmail } from './templates.js';
import { type SmtpReceipt, sendSmtp } from './transport.js';

/** What the send test reports: where the mail went and the relay's answer. Never credentials. */
export interface SendTestResult {
  to: string;
  from: string;
  host: string;
  port: number;
  tls: 'implicit' | 'starttls' | 'opportunistic';
  receipt: SmtpReceipt;
}

/**
 * Sends one test email with the worker's SMTP settings, the path notification emails,
 * digests and notices take. Throws ConfigError when SMTP isn't configured or `to` isn't an
 * address; SMTP errors (refused login, no STARTTLS, rejected recipient) propagate.
 */
export async function sendTestEmail(
  env: Record<string, string | undefined>,
  to: string,
  now = new Date()
): Promise<SendTestResult> {
  const config = loadWorkerConfig(env);
  if (!config.smtp) throw new ConfigError(['SMTP_HOST: not set, so mail is logged, not sent']);
  const address = z.email().safeParse(to.trim());
  if (!address.success)
    throw new ConfigError([`recipient: ${JSON.stringify(to)} is not an email address`]);
  const { smtp } = config;
  const receipt = await sendSmtp(smtp, config.mailFrom, {
    to: address.data,
    ...testEmail({ appUrl: config.appUrl, sentAt: now }),
  });
  return {
    to: address.data,
    from: config.mailFrom,
    host: smtp.host,
    port: smtp.port,
    tls: smtp.secure ? 'implicit' : smtp.requireTls ? 'starttls' : 'opportunistic',
    receipt,
  };
}
