import { createHash, randomBytes } from 'node:crypto';
import { type AutomationAction, STEP_LISTS, type StepListName } from '@openrows/shared';
import { z } from 'zod';
import type { Cipher } from '../auth/crypto.js';

/**
 * The secret parts of an automation's actions: secret HTTP header values and Slack and Discord
 * webhook URLs. They never sit in the `actions` column (which the API returns): the stored
 * actions keep a secret header as `{ name, secret: true }` and a Slack or Discord step without
 * its URL, and the values
 * live in `secrets_encrypted`, one AES-GCM document, one entry per step by index. A branch's or
 * repeat's entry holds its lists' entries the same way (`then`, `otherwise`, `actions`).
 */
export interface StepSecrets {
  /** Secret header values by lower-cased name. */
  headers?: Record<string, string>;
  /** A Slack or Discord step's webhook URL. */
  webhookUrl?: string;
  then?: AutomationSecrets;
  otherwise?: AutomationSecrets;
  actions?: AutomationSecrets;
}
export type AutomationSecrets = (StepSecrets | null)[];

const stepSecretsSchema: z.ZodType<StepSecrets> = z.object({
  headers: z.record(z.string(), z.string()).optional(),
  webhookUrl: z.string().optional(),
  // biome-ignore lint/suspicious/noThenProperty: a list of entries (an array, never a function)
  get then() {
    return secretsSchema.optional();
  },
  get otherwise() {
    return secretsSchema.optional();
  },
  get actions() {
    return secretsSchema.optional();
  },
});
const secretsSchema: z.ZodType<AutomationSecrets> = z.array(stepSecretsSchema.nullable());

/** Whether a list's entries hold any secret value (nested lists too). */
function holdsSecrets(secrets: AutomationSecrets): boolean {
  return secrets.some(
    (s) =>
      !!s &&
      (!!s.webhookUrl ||
        Object.keys(s.headers ?? {}).length > 0 ||
        STEP_LISTS.some((name) => holdsSecrets(s[name] ?? [])))
  );
}

export function readSecrets(cipher: Cipher, data: Buffer | null | undefined): AutomationSecrets {
  if (!data) return [];
  const text = cipher.decrypt(data);
  if (text === undefined) return [];
  const parsed = secretsSchema.safeParse(JSON.parse(text));
  return parsed.success ? parsed.data : [];
}

export function writeSecrets(cipher: Cipher, secrets: AutomationSecrets): Buffer | null {
  return holdsSecrets(secrets) ? cipher.encrypt(JSON.stringify(secrets)) : null;
}

export interface SplitProblem {
  path: string;
  message: string;
}

/**
 * Takes the secrets out of actions as a client sent them: a secret header, Slack or Discord URL
 * with a value is a new secret; one without keeps what the same step (same place and type; for HTTP,
 * the same URL) had, or is a problem. Steps inside branches and repeats likewise, by their
 * place in the same group's list. Returns the actions to store (no secret values) and the secrets.
 */
export function splitSecrets(
  actions: readonly AutomationAction[],
  previous: { actions: readonly AutomationAction[]; secrets: AutomationSecrets },
  /** Where `actions` sit, for problems' paths (`actions`, `actions.2.then`). */
  at = 'actions'
): { actions: AutomationAction[]; secrets: AutomationSecrets; problems: SplitProblem[] } {
  const problems: SplitProblem[] = [];
  const secrets: AutomationSecrets = [];
  const stored = actions.map((action, i): AutomationAction => {
    const was = previous.actions[i];
    const before = was?.type === action.type ? previous.secrets[i] : undefined;
    if (action.type === 'branch' || action.type === 'repeat') {
      const lists: StepListName[] = action.type === 'branch' ? ['then', 'otherwise'] : ['actions'];
      const entry: StepSecrets = {};
      const out: Record<string, AutomationAction[]> = {};
      for (const name of lists) {
        const prev = was?.type === action.type ? listOf(was, name) : [];
        const split = splitSecrets(
          listOf(action, name),
          { actions: prev, secrets: before?.[name] ?? [] },
          `${at}.${i}.${name}`
        );
        problems.push(...split.problems);
        out[name] = split.actions;
        if (holdsSecrets(split.secrets)) entry[name] = split.secrets;
      }
      secrets.push(Object.keys(entry).length ? entry : null);
      return { ...action, ...out } as AutomationAction;
    }
    if (action.type === 'httpRequest') {
      // Kept secret headers go only where they went: a new URL needs them entered again, so no
      // one can send someone else's stored secret to a server of their choosing.
      const sameUrl = was?.type === 'httpRequest' && was.url === action.url;
      const headers: Record<string, string> = {};
      const out = action.headers.map((h, j) => {
        if (!h.secret) return h;
        const key = h.name.toLowerCase();
        const value = h.value ?? (sameUrl ? before?.headers?.[key] : undefined);
        if (value === undefined) {
          problems.push({
            path: `${at}.${i}.headers.${j}.value`,
            message: `Enter the value of the secret header ${h.name}.`,
          });
        } else headers[key] = value;
        return { name: h.name, secret: true };
      });
      secrets.push(Object.keys(headers).length ? { headers } : null);
      return { ...action, headers: out };
    }
    if (action.type === 'slackMessage' || action.type === 'discordMessage') {
      // Kept only by a step of the same type: a Slack URL never becomes a Discord one.
      const webhookUrl = action.webhookUrl ?? before?.webhookUrl;
      if (webhookUrl === undefined) {
        problems.push({
          path: `${at}.${i}.webhookUrl`,
          message:
            action.type === 'slackMessage'
              ? 'Enter the Slack incoming webhook URL.'
              : 'Enter the Discord webhook URL.',
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

/** A branch's or repeat's list of steps. */
function listOf(action: AutomationAction, name: StepListName): AutomationAction[] {
  if (action.type === 'branch' && (name === 'then' || name === 'otherwise')) return action[name];
  if (action.type === 'repeat' && name === 'actions') return action.actions;
  return [];
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
