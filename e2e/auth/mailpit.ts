import { MAILPIT_URL } from './env.js';

interface Summary {
  ID: string;
  Subject: string;
}

/**
 * Waits for the newest message to `to` (whose subject contains `subject`, when given) and
 * returns its plain text.
 */
export async function latestMessageTo(
  to: string,
  timeoutMs = 15_000,
  subject?: string
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const query = subject ? `to:"${to}" subject:"${subject}"` : `to:"${to}"`;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(query)}&limit=1`
    );
    const { messages } = (await res.json()) as { messages: Summary[] };
    const [latest] = messages;
    if (latest) {
      const msg = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${latest.ID}`)).json()) as {
        Text: string;
      };
      return msg.Text;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email to ${to} within ${timeoutMs} ms`);
}
