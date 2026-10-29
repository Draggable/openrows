import {
  type AutomationAction,
  MAX_EMAIL_RECIPIENTS,
  REDACTED,
  renderTemplate,
  renderTemplateValue,
  templateValueText,
} from '@openrows/shared';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Cipher } from '../auth/crypto.js';
import { effectiveRole } from '../authz/policy.js';
import { resolveResource } from '../authz/resolve.js';
import { automationEmailCounts, type Database, type Transaction, users } from '../db/index.js';
import { automationEmail } from '../email/templates.js';
import type { EmailTransport } from '../email/transport.js';
import { withTenant } from '../jobs/tenant.js';
import { type SafeFetch, SafeFetchError } from '../lib/safe-fetch/index.js';
import type { StepSecrets } from './secrets.js';

/**
 * The outbound actions of automations: send email, HTTP request, Slack message. They run
 * inside the run's transaction but reach outside it, so a run retried after a crash may send
 * again (at least once); a step's own failures (a refused URL, a non-2xx answer, the email cap)
 * fail the step, not the job.
 */

/** What the worker gives outbound steps; without it they fail with "not configured". */
export interface OutboundDeps {
  /** The `automation-secret` cipher. */
  cipher: Cipher;
  /** The SSRF-safe client under the server's OUTBOUND_HTTP_* rules. */
  http: SafeFetch;
  email: EmailTransport;
  /** Emails (recipients) per workspace and UTC day (`AUTOMATION_EMAIL_DAILY_LIMIT`). */
  emailDailyLimit: number;
  /**
   * The workspace's outbound rate, set by `gatedOutbound` for live runs: an email step
   * takes one token before its quota. Throws OutboundDeferred.
   */
  acquire?: () => Promise<void>;
}

/**
 * The outbound steps of one live run under its workspace's outbound rate: every HTTP or
 * Slack request (and run-script `fetch`, which uses the same client) takes a token first, and so
 * does an email step. `acquire` throws OutboundDeferred when the workspace must wait longer.
 */
export function gatedOutbound(deps: OutboundDeps, acquire: () => Promise<void>): OutboundDeps {
  return {
    ...deps,
    http: async (url, init) => {
      await acquire();
      return deps.http(url, init);
    },
    acquire,
  };
}

export const DEFAULT_AUTOMATION_EMAIL_DAILY_LIMIT = 100;
/** An HTTP step's answer kept for later steps and the log. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
const HTTP_TIMEOUT_MS = 15_000;

/** A step's failure with a message for the run log. */
export class StepFailure extends Error {
  override name = 'StepFailure';
  constructor(
    message: string,
    /** What the step still shows in the run log (a failed script's logs). */
    readonly output?: unknown
  ) {
    super(message);
  }
}

export interface OutboundEnv {
  workspaceId: string;
  baseId: string;
  baseName: string;
  automationName: string;
  outbound: OutboundDeps | undefined;
}

type Rendered<T extends AutomationAction['type']> = Extract<AutomationAction, { type: T }>;

/** Fills in the tokens of an outbound action. Secret header values are sent as written. */
export function renderOutbound(
  action: Rendered<'sendEmail' | 'httpRequest' | 'slackMessage'>,
  context: Record<string, unknown>
) {
  const text = (s: string) => templateValueText(renderTemplate(s, context));
  switch (action.type) {
    case 'sendEmail':
      return {
        ...action,
        to: action.to.map((v) => renderTemplate(v, context)),
        subject: text(action.subject),
        body: text(action.body),
      };
    case 'httpRequest':
      return {
        ...action,
        url: text(action.url),
        headers: action.headers.map((h) => (h.secret ? h : { ...h, value: text(h.value ?? '') })),
        body: renderTemplateValue(action.body, context),
      };
    case 'slackMessage':
      return { ...action, text: text(action.text) };
  }
}

/** A URL for the run log: its query string's values may be secrets, so they are left out. */
export function logUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? `?${REDACTED}` : ''}`;
  } catch {
    return url.slice(0, 200);
  }
}

/** What the run log keeps of a rendered outbound step: no header values, no Slack URL. */
export function logInput(input: ReturnType<typeof renderOutbound>): unknown {
  switch (input.type) {
    case 'httpRequest':
      return {
        ...input,
        url: logUrl(input.url),
        headers: input.headers.map((h) => ({ name: h.name, value: REDACTED, secret: h.secret })),
      };
    case 'slackMessage':
      return { ...input, webhookUrl: REDACTED };
    default:
      return input;
  }
}

function configured(env: OutboundEnv): OutboundDeps {
  if (!env.outbound) {
    throw new StepFailure("This server isn't set up to run outbound actions.");
  }
  return env.outbound;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const email = z.email();

/** The addresses and user ids `to` names: strings split at commas and spaces, lists, users. */
function recipientsOf(values: readonly unknown[]) {
  const addresses = new Set<string>();
  const userIds = new Set<string>();
  const add = (v: unknown): void => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) {
      for (const item of v) add(item);
      return;
    }
    if (typeof v === 'object') {
      const o = v as { email?: unknown; id?: unknown };
      if (typeof o.email === 'string') add(o.email);
      else if (typeof o.id === 'string') add(o.id);
      return;
    }
    if (typeof v !== 'string') return;
    for (const part of v.split(/[\s,;]+/).filter(Boolean)) {
      if (UUID_RE.test(part)) userIds.add(part.toLowerCase());
      else if (email.safeParse(part).success) addresses.add(part.toLowerCase());
      else throw new StepFailure(`"${part.slice(0, 80)}" isn't an email address.`);
    }
  };
  values.forEach(add);
  return { addresses, userIds };
}

/**
 * Takes `n` emails from the workspace's daily cap, in its own committed transaction (a send
 * can't be taken back, so neither is its count). False when they don't fit.
 */
export async function takeEmailQuota(
  db: Database,
  workspaceId: string,
  n: number,
  limit: number
): Promise<boolean> {
  if (n > limit) return false;
  return withTenant(db, workspaceId, async (tx) => {
    const rows = await tx
      .insert(automationEmailCounts)
      .values({ workspaceId, day: sql`(now() AT TIME ZONE 'UTC')::date`, sent: n })
      .onConflictDoUpdate({
        target: [automationEmailCounts.workspaceId, automationEmailCounts.day],
        set: { sent: sql`${automationEmailCounts.sent} + ${n}` },
        setWhere: sql`${automationEmailCounts.sent} + ${n} <= ${limit}`,
      })
      .returning({ sent: automationEmailCounts.sent });
    return rows.length > 0;
  });
}

export async function sendEmailStep(
  tx: Transaction,
  db: Database,
  env: OutboundEnv,
  input: ReturnType<typeof renderOutbound> & { type: 'sendEmail' }
) {
  const deps = configured(env);
  const { addresses, userIds } = recipientsOf(input.to);
  // People by id only when they can see the base (a user field may name a past collaborator).
  let skipped = 0;
  if (userIds.size) {
    const found = await tx
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    for (const id of userIds) {
      const user = found.find((u) => u.id === id);
      const resolved = user ? await resolveResource(tx, 'base', env.baseId, id) : null;
      if (user?.email && resolved && effectiveRole(resolved))
        addresses.add(user.email.toLowerCase());
      else skipped++;
    }
  }
  const to = [...addresses];
  if (to.length === 0) throw new StepFailure('There is no one to send the email to.');
  if (to.length > MAX_EMAIL_RECIPIENTS) {
    throw new StepFailure(`One email step sends to at most ${MAX_EMAIL_RECIPIENTS} people.`);
  }
  await deps.acquire?.();
  if (!(await takeEmailQuota(db, env.workspaceId, to.length, deps.emailDailyLimit))) {
    throw new StepFailure(
      `The workspace reached its limit of ${deps.emailDailyLimit} automation emails today (UTC).`
    );
  }
  const content = automationEmail({
    subject: input.subject,
    body: input.body,
    baseName: env.baseName,
    automationName: env.automationName,
  });
  // One message per recipient: nobody sees the others' addresses.
  for (const address of to) await deps.email.send({ ...content, to: address });
  return { sent: to.length, to, ...(skipped ? { skipped } : {}) };
}

/** The response as later steps see it: JSON when it says so, else text. */
function responseBody(res: { headers: Headers; text(): string }): unknown {
  const text = res.text();
  if (/\bjson\b/i.test(res.headers.get('content-type') ?? '')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

async function request(
  http: SafeFetch,
  url: string,
  init: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers: Record<string, string>;
    body?: string;
  }
) {
  try {
    const res = await http(url, {
      ...init,
      maxBytes: MAX_RESPONSE_BYTES,
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    return res;
  } catch (err) {
    if (err instanceof SafeFetchError) throw new StepFailure(`The request failed: ${err.message}.`);
    throw err;
  }
}

export async function httpRequestStep(
  env: OutboundEnv,
  input: ReturnType<typeof renderOutbound> & { type: 'httpRequest' },
  secrets: StepSecrets | null | undefined
) {
  const deps = configured(env);
  const headers: Record<string, string> = {};
  for (const h of input.headers) {
    const value = h.secret ? secrets?.headers?.[h.name.toLowerCase()] : h.value;
    if (value === undefined) {
      throw new StepFailure(`The secret header ${h.name} has no value; enter it again.`);
    }
    headers[h.name] = value;
  }
  let body: string | undefined;
  if (input.method !== 'GET' && input.body !== undefined) {
    body = JSON.stringify(input.body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }
  const res = await request(deps.http, input.url, {
    method: input.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  if (res.status < 200 || res.status > 299) {
    throw new StepFailure(
      `The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`
    );
  }
  return { status: res.status, body: responseBody(res) };
}

export async function slackMessageStep(
  env: OutboundEnv,
  input: ReturnType<typeof renderOutbound> & { type: 'slackMessage' },
  secrets: StepSecrets | null | undefined
) {
  const deps = configured(env);
  const url = secrets?.webhookUrl;
  if (!url) throw new StepFailure('The Slack webhook URL is missing; enter it again.');
  const res = await request(deps.http, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: input.text }),
  });
  if (res.status < 200 || res.status > 299) {
    throw new StepFailure(
      `Slack answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`
    );
  }
  return { status: res.status };
}
