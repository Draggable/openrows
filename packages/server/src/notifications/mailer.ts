import type { NotificationEmailFrequency, NotificationKind } from '@openrows/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { inScope } from '../authz/scope.js';
import { type Database, notifications, users } from '../db/index.js';
import {
  type NotificationDigestRecord,
  type NotificationEmailItem,
  notificationDigestEmail,
  notificationEmail,
} from '../email/templates.js';
import type { EmailTransport } from '../email/transport.js';
import type { Logger } from '../lib/logger.js';
import { displayName } from '../workspaces/collaborators.js';
import { type NotificationDetails, notificationDetails } from './service.js';
import { unsubscribeToken } from './unsubscribe.js';

/** At most one email per recipient and record in this window (pending ones wait and coalesce). */
export const NOTIFICATION_EMAIL_THROTTLE_MS = 10 * 60 * 1000;
/** Notifications claimed per immediate run. */
const CLAIM_BATCH = 500;
/** Recipients claimed per digest claim, and claims per digest run. */
const DIGEST_USERS_PER_CLAIM = 50;
const DIGEST_CLAIMS_PER_RUN = 200;

/** A notification as the claim returns it (snake_case: raw SQL). */
interface ClaimedRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  user_id: string;
  actor_id: string | null;
  kind: NotificationKind;
  base_id: string;
  table_id: string;
  record_id: string;
  comment_id: string | null;
  field_id: string | null;
  created_at: string | Date;
}

/** The link that opens the record (and the comment) in the app. */
export function recordUrl(
  appUrl: string,
  n: { baseId: string; tableId: string; recordId: string; commentId?: string | null }
): string {
  const url = new URL(`/b/${n.baseId}/${n.tableId}`, appUrl);
  url.searchParams.set('record', n.recordId);
  if (n.commentId) url.searchParams.set('comment', n.commentId);
  return url.href;
}

/** What a run did: emails sent, groups (or digests) with nothing to send. */
export interface MailerResult {
  sent: number;
  skipped: number;
}

/** A send failed for good (the relay refused the recipient: 5xx): retrying won't help. */
function permanent(err: unknown): boolean {
  const code = (err as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === 'number' && code >= 500 && code < 600;
}

/**
 * Notification emails, sent by the worker (ADR-004): the `notifications.email` job
 * (every minute, and soon after a notification is created) and the hourly and daily digest jobs.
 *
 * Immediately: each run claims due notifications of recipients who want emails as they come
 * (`notifications_email_claim`: pending, and no email to that recipient about that record in the
 * last 10 minutes) and sends one email per recipient and record. Digests
 * (`notifications_digest_claim`): everything pending of recipients on that frequency, one email
 * each, grouped by record. At send time either way: the recipient's preference (all, mentions
 * only, none), a verified address, and access re-checked in their scope (`notificationDetails`: a
 * live table and record, a role on the base); only the record's name and the comment excerpts go
 * out. What isn't sent is marked `skipped`. A failed send is put back (`pending`) and the run
 * throws, so pg-boss retries it with backoff; a refused recipient (5xx) is skipped.
 */
export class NotificationMailer {
  #running: Promise<MailerResult> | undefined;

  constructor(
    private readonly deps: {
      db: Database;
      email: EmailTransport;
      appUrl: string;
      secret: string;
      logger: Pick<Logger, 'info' | 'warn'>;
      throttleMs?: number;
    }
  ) {}

  /** One immediate pass; concurrent calls share it. */
  run(): Promise<MailerResult> {
    this.#running ??= this.#run().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #run(): Promise<MailerResult> {
    const { db } = this.deps;
    const throttle = Math.round((this.deps.throttleMs ?? NOTIFICATION_EMAIL_THROTTLE_MS) / 1000);
    const { rows } = await db.execute<ClaimedRow>(
      sql`SELECT * FROM notifications_email_claim(${throttle}, ${CLAIM_BATCH})`
    );
    const groups = new Map<string, ClaimedRow[]>();
    for (const row of rows) {
      const key = `${row.user_id}:${row.record_id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return this.#sendAll([...groups.values()], (group) => this.#sendRecord(group));
  }

  /**
   * One digest pass for `frequency`: claims recipients on it with pending notifications, a batch
   * at a time, and sends each one digest. Two workers (or a retry) never send the same
   * notification twice: a claim marks them `sending`.
   */
  async runDigest(frequency: Exclude<NotificationEmailFrequency, 'immediately'>) {
    const { db } = this.deps;
    const total: MailerResult = { sent: 0, skipped: 0 };
    let failure: unknown;
    for (let i = 0; i < DIGEST_CLAIMS_PER_RUN; i++) {
      const { rows } = await db.execute<ClaimedRow>(
        sql`SELECT * FROM notifications_digest_claim(${frequency}, ${DIGEST_USERS_PER_CLAIM})`
      );
      if (rows.length === 0) break;
      const byUser = new Map<string, ClaimedRow[]>();
      for (const row of rows) byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row]);
      try {
        const result = await this.#sendAll([...byUser.values()], (group) =>
          this.#sendDigest(frequency, group)
        );
        total.sent += result.sent;
        total.skipped += result.skipped;
      } catch (err) {
        // The failed ones are put back: stop claiming (they'd be claimed again right away) and
        // let pg-boss retry the run with backoff.
        failure = err;
        break;
      }
    }
    if (failure) throw failure;
    return total;
  }

  /** Sends each group; failed ones are put back and the pass throws once all were tried. */
  async #sendAll(
    groups: ClaimedRow[][],
    send: (group: ClaimedRow[]) => Promise<boolean>
  ): Promise<MailerResult> {
    let sent = 0;
    let skipped = 0;
    let failure: unknown;
    for (const group of groups) {
      try {
        if (await send(group)) sent += 1;
        else skipped += 1;
      } catch (err) {
        const final = permanent(err);
        this.deps.logger.warn({ err, permanent: final }, 'notification email failed');
        await this.#mark(group, final ? 'skipped' : 'pending').catch(() => {
          // Left `sending`: the claim takes it again after 15 minutes.
        });
        if (final) skipped += 1;
        else failure = err;
      }
    }
    if (failure) throw failure;
    return { sent, skipped };
  }

  /** Sets the email state of `rows` (one recipient's), in their scope, per workspace. */
  async #mark(rows: readonly ClaimedRow[], state: 'sent' | 'skipped' | 'pending') {
    const userId = rows[0]?.user_id;
    if (!userId) return;
    for (const workspaceId of new Set(rows.map((r) => r.workspace_id))) {
      const ids = rows.filter((r) => r.workspace_id === workspaceId).map((r) => r.id);
      await inScope(this.deps.db, { userId, workspaceId }, async (tx) => {
        await tx
          .update(notifications)
          .set(state === 'sent' ? { emailState: state } : { emailState: state, emailedAt: null })
          .where(and(eq(notifications.userId, userId), inArray(notifications.id, ids)));
      });
    }
  }

  /**
   * What of `group` (one recipient's) may go out: the preference, a verified address, and the
   * details of those they can still read (per workspace). The rest is marked `skipped` here.
   */
  async #prepare(group: ClaimedRow[]) {
    const { db } = this.deps;
    const userId = group[0]?.user_id;
    if (!userId) return undefined;
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const preference = user?.notificationEmail ?? 'none';
    const canMail = !!user?.email && user.emailVerified && this.deps.email.delivers !== false;
    const wanted = canMail
      ? group.filter(
          (n) => preference === 'all' || (preference === 'mentions' && n.kind === 'mention')
        )
      : [];
    const details = new Map<string, NotificationDetails>();
    for (const workspaceId of new Set(wanted.map((r) => r.workspace_id))) {
      const of = wanted.filter((r) => r.workspace_id === workspaceId);
      const found = await notificationDetails(
        db,
        userId,
        workspaceId,
        of.map((r) => ({
          id: r.id,
          tableId: r.table_id,
          recordId: r.record_id,
          commentId: r.comment_id,
          fieldId: r.field_id,
        }))
      );
      for (const [id, d] of found) details.set(id, d);
    }
    const shown = wanted.filter((r) => details.has(r.id));
    const shownIds = new Set(shown.map((r) => r.id));
    await this.#mark(
      group.filter((r) => !shownIds.has(r.id)),
      'skipped'
    );
    if (shown.length === 0 || !user?.email) return undefined;
    const actorIds = [...new Set(shown.flatMap((r) => (r.actor_id ? [r.actor_id] : [])))];
    const actors = new Map(
      (actorIds.length ? await db.select().from(users).where(inArray(users.id, actorIds)) : []).map(
        (u) => [u.id, displayName(u, false)]
      )
    );
    const item = (r: ClaimedRow): NotificationEmailItem => {
      const info = details.get(r.id);
      return {
        kind: r.kind,
        actorName: (r.actor_id && actors.get(r.actor_id)) || 'Someone',
        excerpt: info?.excerpt ?? null,
        fieldName: info?.fieldName ?? null,
      };
    };
    return { to: user.email, userId, shown, details, item };
  }

  #links(userId: string) {
    const { appUrl, secret } = this.deps;
    const unsubscribeUrl = `${appUrl}/email/unsubscribe?token=${encodeURIComponent(unsubscribeToken(secret, userId))}`;
    return {
      unsubscribeUrl,
      preferencesUrl: `${appUrl}/settings`,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  /** Emails one recipient about one record; false when nothing was sent. */
  async #sendRecord(group: ClaimedRow[]): Promise<boolean> {
    const ready = await this.#prepare(group);
    const target = ready?.shown[0];
    if (!ready || !target) return false;
    const d = ready.details.get(target.id);
    const latestComment = [...ready.shown].reverse().find((r) => r.comment_id)?.comment_id ?? null;
    const { headers, ...links } = this.#links(ready.userId);
    const content = notificationEmail({
      recordName: d?.recordName ?? '',
      baseName: d?.baseName ?? '',
      items: ready.shown.map(ready.item),
      recordUrl: recordUrl(this.deps.appUrl, {
        baseId: target.base_id,
        tableId: target.table_id,
        recordId: target.record_id,
        commentId: latestComment,
      }),
      ...links,
    });
    await this.deps.email.send({ to: ready.to, ...content, headers });
    await this.#mark(ready.shown, 'sent');
    return true;
  }

  /** One recipient's digest, grouped by record, latest activity first; false when nothing was sent. */
  async #sendDigest(
    frequency: Exclude<NotificationEmailFrequency, 'immediately'>,
    group: ClaimedRow[]
  ): Promise<boolean> {
    const ready = await this.#prepare(group);
    if (!ready) return false;
    const byRecord = new Map<string, ClaimedRow[]>();
    for (const r of ready.shown) {
      byRecord.set(r.record_id, [...(byRecord.get(r.record_id) ?? []), r]);
    }
    const time = (r: ClaimedRow) => new Date(r.created_at).getTime();
    const latest = (rows: ClaimedRow[]) => Math.max(...rows.map(time));
    const records: NotificationDigestRecord[] = [...byRecord.values()]
      .map((rows) => rows.sort((a, b) => time(a) - time(b)))
      .sort((a, b) => latest(b) - latest(a))
      .flatMap((rows) => {
        const first = rows[0];
        const d = first && ready.details.get(first.id);
        if (!first || !d) return [];
        const latestComment = [...rows].reverse().find((r) => r.comment_id)?.comment_id ?? null;
        return [
          {
            recordName: d.recordName,
            tableName: d.tableName,
            baseName: d.baseName,
            recordUrl: recordUrl(this.deps.appUrl, {
              baseId: first.base_id,
              tableId: first.table_id,
              recordId: first.record_id,
              commentId: latestComment,
            }),
            items: rows.map(ready.item),
          },
        ];
      });
    const { headers, ...links } = this.#links(ready.userId);
    const content = notificationDigestEmail({ frequency, records, ...links });
    await this.deps.email.send({ to: ready.to, ...content, headers });
    await this.#mark(ready.shown, 'sent');
    return true;
  }
}
