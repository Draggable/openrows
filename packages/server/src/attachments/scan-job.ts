import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { attachments, bases, type Database, shares, users, views } from '../db/index.js';
import { attachmentQuarantinedEmail } from '../email/templates.js';
import type { EmailTransport } from '../email/transport.js';
import { tenantJobData, withTenant } from '../jobs/tenant.js';
import type { Logger } from '../lib/logger.js';
import type { MalwareScanner } from './scan.js';
import { SCAN_QUEUE } from './service.js';
import type { ObjectStore } from './storage.js';
import { thumbnailAttachment } from './thumbnails.js';

/**
 * The worker's malware scans. `attachments.scan` scans one `scanning` file: the stored
 * object is streamed to clamd (never held in memory, never in a transaction), then the row is
 * marked `ready` (and its thumbnail made) or `infected`, which quarantines it: the object stays
 * in the bucket for an operator to review, but nothing serves it or lets a cell take it again,
 * and the uploader is emailed. A scanner that is down, slow or erroring throws, so the job is
 * retried and the file waits; `attachments.scan.sweep` re-sends the scans of files still waiting
 * well after their confirmation (retries ran out, or the file came from an Airtable import).
 */

export const scanJobData = tenantJobData.extend({ attachmentId: z.uuid() });

export interface ScanDeps {
  db: Database;
  store: ObjectStore;
  scanner: MalwareScanner;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** The uploader's email; without it, only the log says so. */
  email?: EmailTransport | undefined;
  appUrl: string;
}

export type ScanOutcome = 'clean' | 'infected' | 'skipped';

export async function runScanJob(deps: ScanDeps, raw: unknown): Promise<{ outcome: ScanOutcome }> {
  const { workspaceId, attachmentId } = scanJobData.parse(raw);
  const [row] = await withTenant(deps.db, workspaceId, (tx) =>
    tx.select().from(attachments).where(eq(attachments.id, attachmentId))
  );
  if (row?.status !== 'scanning') return { outcome: 'skipped' };
  const verdict = await deps.scanner.scan(await deps.store.getStream(row.storageKey));
  const scannedAt = new Date();
  const [updated] = await withTenant(deps.db, workspaceId, (tx) =>
    tx
      .update(attachments)
      .set(
        verdict.infected
          ? { status: 'infected', scannedAt, scanResult: verdict.signature }
          : { status: 'ready', scannedAt }
      )
      // Only while it still waits: a concurrent scan of the same file changes nothing twice.
      .where(and(eq(attachments.id, row.id), eq(attachments.status, 'scanning')))
      .returning({ id: attachments.id })
  );
  if (!updated) return { outcome: 'skipped' };
  if (!verdict.infected) {
    await thumbnailAttachment(deps.db, deps.store, {
      workspaceId,
      userId: '',
      attachmentId: row.id,
    }).catch((err: unknown) =>
      deps.logger.warn({ err, attachmentId: row.id }, 'thumbnail after scan failed')
    );
    return { outcome: 'clean' };
  }
  deps.logger.warn(
    { workspaceId, attachmentId: row.id, baseId: row.baseId, signature: verdict.signature },
    'attachment quarantined: malware found'
  );
  await tellUploader(deps, row, verdict.signature).catch((err: unknown) =>
    deps.logger.warn({ err, attachmentId: row.id }, 'quarantine email failed')
  );
  return { outcome: 'infected' };
}

/** Emails the uploader, or a form submitter's form link creator, about a quarantined file. */
async function tellUploader(
  deps: ScanDeps,
  row: typeof attachments.$inferSelect,
  signature: string
): Promise<void> {
  if (!deps.email) return;
  const found = await withTenant(deps.db, row.workspaceId, async (tx) => {
    const [share] = row.shareId
      ? await tx
          .select({ createdBy: shares.createdBy, viewName: views.name })
          .from(shares)
          .leftJoin(views, eq(views.id, shares.viewId))
          .where(eq(shares.id, row.shareId))
      : [];
    const recipient = share ? share.createdBy : row.createdBy;
    const [user] = recipient
      ? await tx
          .select({ email: users.email, verified: users.emailVerified })
          .from(users)
          .where(eq(users.id, recipient))
      : [];
    const [base] = await tx
      .select({ name: bases.name })
      .from(bases)
      .where(eq(bases.id, row.baseId));
    return { user, base, formName: share?.viewName ?? undefined };
  });
  if (!found.user?.email || !found.user.verified || !found.base) return;
  await deps.email.send({
    to: found.user.email,
    ...attachmentQuarantinedEmail({
      filename: row.filename,
      baseName: found.base.name,
      signature,
      formName: found.formName,
      baseUrl: `${deps.appUrl}/b/${row.baseId}`,
    }),
  });
}

/** Files still `scanning` this long after their confirmation get their scan sent again. */
export const SCAN_SWEEP_AFTER_MS = 2 * 60_000;
const SWEEP_PAGE = 500;

/** Re-sends the scans of waiting files (one queued per file: the singleton key). */
export async function sweepScans(
  db: Database,
  boss: Pick<PgBoss, 'send'>,
  now: Date = new Date()
): Promise<{ sent: number }> {
  const before = new Date(now.getTime() - SCAN_SWEEP_AFTER_MS);
  const { rows } = await db.execute<{ workspace_id: string; attachment_id: string }>(
    sql`SELECT workspace_id, attachment_id FROM attachments_scan_backlog(${before.toISOString()}::timestamptz, ${SWEEP_PAGE})`
  );
  let sent = 0;
  for (const r of rows) {
    const id = await boss.send(
      SCAN_QUEUE,
      { workspaceId: r.workspace_id, attachmentId: r.attachment_id },
      { singletonKey: r.attachment_id }
    );
    if (id) sent++;
  }
  return { sent };
}
