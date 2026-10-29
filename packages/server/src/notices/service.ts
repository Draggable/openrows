import {
  NOTICE_AUDIENCES,
  NOTICE_BANNER_DAYS_AFTER,
  NOTICE_KINDS,
  NOTICE_MIN_DAYS,
  NOTICE_SUMMARY_MAX,
  NOTICE_TITLE_MAX,
  type Notice,
  type NoticeAudience,
  type NoticeKind,
} from '@openrows/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';
import { inScope } from '../authz/scope.js';
import type { Database } from '../db/index.js';
import { legalNoticeDismissals, legalNotices } from '../db/schema.js';
import { legalNoticeEmail } from '../email/templates.js';
import type { EmailTransport } from '../email/transport.js';
import { AppError } from '../lib/errors.js';

/**
 * Service notices: Terms, privacy, price and plan changes announced ahead of time by email
 * (the `notices` command, cli.ts) and as a dismissible banner in the app. A notice is global; the
 * banner shows from publication until NOTICE_BANNER_DAYS_AFTER days after the change takes
 * effect, to every account it concerns (`owners`: owners of a live workspace) that hasn't
 * dismissed it.
 */

const DAY_MS = 86_400_000;

type Row = typeof legalNotices.$inferSelect;

function toNotice(r: Row): Notice {
  return {
    id: r.id,
    kind: r.kind as NoticeKind,
    title: r.title,
    summary: r.summary,
    url: r.url,
    effectiveAt: r.effectiveAt.toISOString(),
    publishedAt: r.publishedAt.toISOString(),
  };
}

/** The notices `userId` should see now: live, in their window, for them, not dismissed. */
function visibleTo(userId: string, now: Date) {
  const since = new Date(now.getTime() - NOTICE_BANNER_DAYS_AFTER * DAY_MS);
  return and(
    sql`${legalNotices.withdrawnAt} IS NULL`,
    sql`${legalNotices.publishedAt} <= ${now.toISOString()}::timestamptz`,
    sql`${legalNotices.effectiveAt} > ${since.toISOString()}::timestamptz`,
    sql`NOT EXISTS (SELECT 1 FROM legal_notice_dismissals d
                     WHERE d.notice_id = ${legalNotices.id} AND d.user_id = ${userId}::uuid)`,
    sql`(${legalNotices.audience} = 'everyone' OR EXISTS (
           SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.user_id = ${userId}::uuid AND m.role = 'owner'
              AND w.deleted_at IS NULL))`
  );
}

/** Banners at once, at most. */
const NOTICES_SHOWN = 10;

/** The live notices `userId` should see and hasn't dismissed, oldest change first. */
export async function listNotices(db: Database, userId: string, now = new Date()) {
  const rows = await inScope(db, { userId }, (tx) =>
    tx
      .select()
      .from(legalNotices)
      .where(visibleTo(userId, now))
      .orderBy(asc(legalNotices.effectiveAt), asc(legalNotices.id))
      .limit(NOTICES_SHOWN)
  );
  return rows.map(toNotice);
}

/**
 * Dismisses a notice's banner for `userId`; dismissing twice is fine, and a notice they don't
 * see (withdrawn, past its window, someone else's audience, unknown) is a 404.
 */
export async function dismissNotice(
  db: Database,
  userId: string,
  noticeId: string,
  now = new Date()
): Promise<void> {
  await inScope(db, { userId }, async (tx) => {
    const [dismissed] = await tx
      .select({ id: legalNoticeDismissals.noticeId })
      .from(legalNoticeDismissals)
      .where(
        and(eq(legalNoticeDismissals.noticeId, noticeId), eq(legalNoticeDismissals.userId, userId))
      );
    if (dismissed) return;
    const [visible] = await tx
      .select({ id: legalNotices.id })
      .from(legalNotices)
      .where(and(eq(legalNotices.id, noticeId), visibleTo(userId, now)));
    if (!visible) throw new AppError('NOT_FOUND', { detail: 'No such notice.' });
    await tx.insert(legalNoticeDismissals).values({ noticeId, userId }).onConflictDoNothing();
  });
}

/** "December 1, 2026" (UTC), as the email and the banner say a date. */
export function noticeDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Whole days of notice left before `effectiveAt`. */
function daysOfNotice(effectiveAt: Date, now: Date) {
  return (effectiveAt.getTime() - now.getTime()) / DAY_MS;
}

/** Thrown for a notice the command refuses (bad input, too little notice). */
export class NoticeError extends Error {}

function assertNoticePeriod(kind: NoticeKind, effectiveAt: Date, now: Date) {
  const min = NOTICE_MIN_DAYS[kind];
  if (effectiveAt.getTime() <= now.getTime()) {
    throw new NoticeError('effective: must be in the future');
  }
  if (daysOfNotice(effectiveAt, now) < min) {
    throw new NoticeError(
      `effective: a ${kind} notice needs at least ${min} days of notice (the Terms promise it); ` +
        `pick a date on or after ${noticeDate(new Date(now.getTime() + min * DAY_MS))}`
    );
  }
}

export const createNoticeSchema = z.strictObject({
  kind: z.enum(NOTICE_KINDS),
  audience: z.enum(NOTICE_AUDIENCES).optional(),
  title: z.string().trim().min(1).max(NOTICE_TITLE_MAX),
  summary: z.string().trim().min(1).max(NOTICE_SUMMARY_MAX),
  url: z.url({ protocol: /^https?$/ }),
  effective: z.coerce.date(),
});
export type CreateNoticeInput = z.input<typeof createNoticeSchema>;

/** Price notices go to workspace owners (who hold the subscriptions); the rest to everyone. */
export function defaultAudience(kind: NoticeKind): NoticeAudience {
  return kind === 'price' ? 'owners' : 'everyone';
}

/** Publishes a notice (its banner shows at once). Throws NoticeError. */
export async function createNotice(db: Database, input: CreateNoticeInput, now = new Date()) {
  const parsed = createNoticeSchema.safeParse(input);
  if (!parsed.success) {
    throw new NoticeError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
    );
  }
  const p = parsed.data;
  assertNoticePeriod(p.kind, p.effective, now);
  const id = uuidv7();
  const audience = p.audience ?? defaultAudience(p.kind);
  await db.execute(sql`SELECT legal_notice_create(${id}::uuid, ${p.kind}, ${audience},
    ${p.title}, ${p.summary}, ${p.url}, ${p.effective.toISOString()}::timestamptz)`);
  return { id, kind: p.kind, audience, effectiveAt: p.effective.toISOString() };
}

/** Takes a notice down: no banner, no more emails. False when it isn't live. */
export async function withdrawNotice(db: Database, id: string): Promise<boolean> {
  const { rows } = await db.execute<{ ok: boolean }>(
    sql`SELECT legal_notice_withdraw(${id}::uuid) AS ok`
  );
  return rows[0]?.ok === true;
}

/** Every notice with its runs (emails sent per run), newest first. */
export async function noticeStatus(db: Database) {
  const notices = await db.select().from(legalNotices).orderBy(sql`${legalNotices.id} DESC`);
  const out = [];
  for (const n of notices) {
    const { rows } = await db.execute<{
      run_id: string;
      sent: number;
      first_sent_at: Date | string;
      last_sent_at: Date | string;
    }>(sql`SELECT * FROM legal_notice_runs(${n.id}::uuid)`);
    out.push({
      ...toNotice(n),
      audience: n.audience,
      withdrawnAt: n.withdrawnAt?.toISOString() ?? null,
      runs: rows.map((r) => ({
        runId: r.run_id,
        sent: r.sent,
        firstSentAt: new Date(r.first_sent_at).toISOString(),
        lastSentAt: new Date(r.last_sent_at).toISOString(),
      })),
    });
  }
  return out;
}

export interface SendNoticeResult {
  noticeId: string;
  runId: string;
  dryRun: boolean;
  /** Accounts this run emailed (or, in a dry run, would email). */
  recipients: number;
  sent: number;
  failed: number;
  /** User ids whose email failed (retried by the next run). */
  failedUserIds: string[];
}

/** Recipients per page. */
const PAGE = 200;

/**
 * Emails a notice to every account it concerns that the log doesn't have yet (so a run that
 * stopped half way picks up where it left off, and running it twice sends nothing twice). Each
 * sent email is logged with the run's id at once. A dry run counts the recipients and sends and
 * logs nothing. Refuses a withdrawn notice, one already in effect, or one left with less notice
 * than its kind needs (NoticeError).
 */
export async function sendNotice(
  deps: {
    db: Database;
    email: EmailTransport;
    appUrl: string;
    log?: (entry: Record<string, unknown>) => void;
  },
  noticeId: string,
  opts: { dryRun: boolean; now?: Date }
): Promise<SendNoticeResult> {
  const { db, email } = deps;
  const now = opts.now ?? new Date();
  const [notice] = await db.select().from(legalNotices).where(eq(legalNotices.id, noticeId));
  if (!notice) throw new NoticeError(`no notice ${noticeId}`);
  if (notice.withdrawnAt) throw new NoticeError(`notice ${noticeId} was withdrawn`);
  const kind = notice.kind as NoticeKind;
  assertNoticePeriod(kind, notice.effectiveAt, now);
  if (!opts.dryRun && email.delivers === false) {
    throw new NoticeError('SMTP_HOST: not set, so the notice would not go out');
  }
  const content = legalNoticeEmail({
    kind,
    title: notice.title,
    summary: notice.summary,
    url: notice.url,
    effective: noticeDate(notice.effectiveAt),
    appUrl: deps.appUrl,
  });
  const runId = uuidv7();
  const result: SendNoticeResult = {
    noticeId,
    runId,
    dryRun: opts.dryRun,
    recipients: 0,
    sent: 0,
    failed: 0,
    failedUserIds: [],
  };
  let after: string | null = null;
  for (;;) {
    const { rows }: { rows: { user_id: string; email: string }[] } = await db.execute(
      sql`SELECT user_id, email FROM legal_notice_recipients(${noticeId}::uuid, ${after}::uuid, ${PAGE})`
    );
    for (const r of rows) {
      result.recipients++;
      if (opts.dryRun) continue;
      try {
        await email.send({ to: r.email, ...content });
        await db.execute(
          sql`SELECT legal_notice_delivered(${noticeId}::uuid, ${r.user_id}::uuid, ${runId}::uuid)`
        );
        result.sent++;
      } catch (err) {
        result.failed++;
        result.failedUserIds.push(r.user_id);
        deps.log?.({
          msg: 'notice email failed',
          userId: r.user_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < PAGE) break;
    after = last.user_id;
  }
  return result;
}
