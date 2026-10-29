/**
 * Sends one test email: `node dist/email/send-test-cli.js <address>` in the worker's
 * container, with its SMTP_* and APP_URL. Prints the relay's answer as JSON (no credentials);
 * exits 1 when the mail didn't go out, 2 on bad usage.
 */
import { ConfigError } from '../config.js';
import { sendTestEmail } from './send-test.js';

const to = process.argv[2];
if (!to || process.argv.length > 3) {
  console.error('Usage: send-test-cli <address>');
  process.exit(2);
}

try {
  console.log(JSON.stringify(await sendTestEmail(process.env, to), null, 2));
} catch (err) {
  if (err instanceof ConfigError) console.error(err.issues.join('\n'));
  // nodemailer's errors carry the SMTP reply (e.g. "535 Incorrect authentication data"), never
  // the password.
  else console.error('Send failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
