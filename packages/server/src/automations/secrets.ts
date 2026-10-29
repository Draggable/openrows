import { createHash, randomBytes } from 'node:crypto';
import type { AutomationAction } from '@openrows/shared';
import { z } from 'zod';
import type { Cipher } from '../auth/crypto.js';

/**
 * The secret parts of an automation's actions: secret HTTP header values and Slack webhook
 * URLs. They never sit in the `actions` column (which the API returns): the stored actions keep
 * a secret header as `{ name, secret: true }` and a Slack step without its URL, and the values
 * live in `secrets_encrypted`, one AES-GCM document, one entry per step by index.
 */
export interface StepSecrets {
  /** Secret header values by lower-cased name. */
  headers?: Record<string, string>;
  webhookUrl?: string;
}
export type AutomationSecrets = (StepSecrets | null)[];

const secretsSchema = z.array(
  z
    .object({
      headers: z.record(z.string(), z.string()).optional(),
      webhookUrl: z.string().optional(),
    })
    .nullable()
);

export function readSecrets(cipher: Cipher, data: Buffer | null | undefined): AutomationSecrets {
  if (!data) return [];
  const text = cipher.decrypt(data);
  if (text === undefined) return [];
  const parsed = secretsSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : [];
}

export function writeSecrets(cipher: Cipher, secrets: AutomationSecrets): Buffer | null {
  return secrets.some((s) => s && (s.webhookUrl || Object.keys(s.headers ?? {}).length))
    ? cipher.encrypt(JSON.stringify(secrets))
    : null;
}

export interface SplitProblem {
  path: string;
  message: string;
}

/**
 * Takes the secrets out of actions as a client sent them: a secret header or Slack URL with a
 * value is a new secret; one without keeps what the same step (same index and type; for HTTP,
 * the same URL) had, or is a problem. Returns the actions to store (no secret values) and the secrets.
 */
export function splitSecrets(
  actions: readonly AutomationAction[],
  previous: { actions: readonly AutomationAction[]; secrets: AutomationSecrets }
): { actions: AutomationAction[]; secrets: AutomationSecrets; problems: SplitProblem[] } {
  const problems: SplitProblem[] = [];
  const secrets: AutomationSecrets = [];
  const stored = actions.map((action, i): AutomationAction => {
    const before = previous.actions[i]?.type === action.type ? previous.secrets[i] : undefined;
    if (action.type === 'httpRequest') {
      // Kept secret headers go only where they went: a new URL needs them entered again, so no
      // one can send someone else's stored secret to a server of their choosing.
      const was = previous.actions[i];
      const sameUrl = was?.type === 'httpRequest' && was.url === action.url;
      const headers: Record<string, string> = {};
      const out = action.headers.map((h, j) => {
        if (!h.secret) return h;
        const key = h.name.toLowerCase();
        const value = h.value ?? (sameUrl ? before?.headers?.[key] : undefined);
        if (value === undefined) {
          problems.push({
            path: `actions.${i}.headers.${j}.value`,
            message: `Enter the value of the secret header ${h.name}.`,
          });
        } else headers[key] = value;
        return { name: h.name, secret: true };
      });
      secrets.push(Object.keys(headers).length ? { headers } : null);
      return { ...action, headers: out };
    }
    if (action.type === 'slackMessage') {
      const webhookUrl = action.webhookUrl ?? before?.webhookUrl;
      if (webhookUrl === undefined) {
        problems.push({
          path: `actions.${i}.webhookUrl`,
          message: 'Enter the Slack incoming webhook URL.',
        });
      }
      secrets.push(webhookUrl ? { webhookUrl } : null);
      const { webhookUrl: _url, ...rest } = action;
      return rest;
    }
    secrets.push(null);
    return action;
  });
  return { actions: stored, secrets, problems };
}

/** A webhook-received trigger's URL token: 192 random bits, the credential itself. */
export function generateHookToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashHookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const HOOK_PATH_PREFIX = '/hooks/a/';

export function hookUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, '')}${HOOK_PATH_PREFIX}${token}`;
}
