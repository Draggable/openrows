import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadGraph, recomputeInPages } from '../data/computed/engine.js';
import { emitMany, type OutboxEvent } from '../data/outbox.js';
import { type Database, fields, outbox, type Transaction, tables } from '../db/index.js';
import type { Logger } from '../lib/logger.js';
import type { OutboxSubscriber } from './relay.js';
import { withTenant } from './tenant.js';

/**
 * Background recomputes of computed fields (ADR-004), both in pages of their own
 * transactions under the base's tenant scope (`withTenant`), with ids-only job data:
 *
 * - `computed.refresh`: fields a write left for the worker (more stale records than the sync
 *   limit, engine.ts). Their `field.recomputing` event reaches this queue through the outbox relay
 *   (`computedSubscriber`); one job recomputes every flagged field of the base, then clears the
 *   flags and emits `field.recomputed`, so clients refetch the table.
 * - `computed.volatile`: the scheduled refresh of formulas calling NOW() or TODAY(), hourly, and
 *   at the half and three-quarter hours for the formulas that also call SET_TIMEZONE (midnight in
 *   time zones with such offsets). Only those formulas and what reads them recompute.
 */

export const COMPUTED_QUEUE = 'computed.refresh';

/**
 * The outbox subscriber of `field.recomputing` events: one job per base, `stately` per
 * singletonKey, so at most one is queued while one runs (the queued one picks up every field
 * flagged meanwhile).
 */
export const computedSubscriber: OutboxSubscriber = {
  queue: COMPUTED_QUEUE,
  async match(events) {
    return events.flatMap((event) =>
      event.kind === 'field.recomputing' && event.baseId
        ? [{ event, subscriberId: 'computed', singletonKey: `computed:${event.baseId}` }]
        : []
    );
  },
};

export const computedJobData = z.object({
  workspaceId: z.uuid(),
  outboxId: z.number().int().positive(),
});

export interface ComputedJobDeps {
  db: Database;
  logger: Pick<Logger, 'info' | 'warn'>;
}

/** Emits one `field.recomputed` per table whose computed values the worker changed. */
async function emitRecomputed(
  tx: Transaction,
  workspaceId: string,
  baseId: string,
  touched: Map<string, Set<string>>
) {
  const events: OutboxEvent[] = [...touched].map(([tableId, ids]) => ({
    workspaceId,
    baseId,
    tableId,
    kind: 'field.recomputed',
    payload: { fieldIds: [...ids] },
    actorId: null,
  }));
  await emitMany(tx, events);
}

/**
 * The `computed.refresh` job: recomputes every computed field of the event's base that waits
 * for the worker, then clears the flags of those not requested again meanwhile (a newer request
 * has its own job). Returns the fields and changed cells.
 */
export async function runComputedRefresh(
  deps: ComputedJobDeps,
  raw: unknown
): Promise<{ fields: number; cells: number }> {
  const data = computedJobData.parse(raw);
  const { db } = deps;
  const inTx = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(db, data.workspaceId, fn);
  const pending = await inTx(async (tx) => {
    const [event] = await tx
      .select({ baseId: outbox.baseId })
      .from(outbox)
      .where(eq(outbox.id, data.outboxId));
    if (!event?.baseId) return null;
    const rows = await tx
      .select({ field: fields, table: tables })
      .from(fields)
      .innerJoin(tables, eq(fields.tableId, tables.id))
      .where(
        and(
          eq(tables.baseId, event.baseId),
          isNotNull(fields.recomputeRequestedAt),
          isNull(fields.deletedAt),
          isNull(tables.deletedAt)
        )
      );
    return { baseId: event.baseId, rows };
  });
  if (!pending?.rows.length) return { fields: 0, cells: 0 };
  const touched = new Map<string, Set<string>>();
  const byTable = new Map<
    string,
    { table: (typeof pending.rows)[number]['table']; ids: string[] }
  >();
  for (const { field, table } of pending.rows) {
    const entry = byTable.get(table.id) ?? { table, ids: [] };
    entry.ids.push(field.id);
    byTable.set(table.id, entry);
    // The flag goes either way: clients refetch the table.
    touched.set(table.id, (touched.get(table.id) ?? new Set()).add(field.id));
  }
  let cells = 0;
  for (const { table, ids } of byTable.values()) {
    cells += await recomputeInPages(inTx, table, ids, { touched });
  }
  await inTx(async (tx) => {
    for (const { field } of pending.rows) {
      if (!field.recomputeRequestedAt) continue;
      await tx
        .update(fields)
        .set({ recomputeRequestedAt: null })
        .where(
          and(eq(fields.id, field.id), lte(fields.recomputeRequestedAt, field.recomputeRequestedAt))
        );
    }
    await emitRecomputed(tx, data.workspaceId, pending.baseId, touched);
  });
  deps.logger.info(
    { baseId: pending.baseId, fields: pending.rows.length, cells },
    'computed fields recomputed'
  );
  return { fields: pending.rows.length, cells };
}

/** Bases per page of `volatile_formula_bases`. */
const BASES_PAGE = 100;

export interface VolatileOptions {
  /** What NOW() and TODAY() read (UTC ms); default: the current time. */
  now?: number;
  /** Only formulas that also call SET_TIMEZONE (the half and three-quarter hour runs). */
  zonedOnly?: boolean;
}

/**
 * The `computed.volatile` job: recomputes the formulas calling NOW() or TODAY() (and what reads
 * them) for every record of every base that has some, one base at a time; a failing base is
 * logged and skipped until the next run. Returns the bases and changed cells.
 */
export async function refreshVolatileFormulas(
  deps: ComputedJobDeps,
  opts: VolatileOptions = {}
): Promise<{ bases: number; cells: number }> {
  const { db, logger } = deps;
  const now = opts.now ?? Date.now();
  let after: string | null = null;
  let bases = 0;
  let cells = 0;
  for (;;) {
    const { rows }: { rows: { workspace_id: string; base_id: string }[] } = await db.execute(
      sql`SELECT workspace_id, base_id FROM volatile_formula_bases(${after}::uuid, ${BASES_PAGE})`
    );
    for (const { workspace_id: workspaceId, base_id: baseId } of rows) {
      try {
        const changed = await refreshVolatileBase(db, workspaceId, baseId, now, opts.zonedOnly);
        if (changed !== null) bases++;
        cells += changed ?? 0;
      } catch (err) {
        logger.warn({ err, baseId }, 'NOW()/TODAY() refresh failed');
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < BASES_PAGE) break;
    after = last.base_id;
  }
  if (cells > 0) logger.info({ bases, cells }, 'NOW()/TODAY() formulas refreshed');
  return { bases, cells };
}

/** One base's clock formulas; null when it has none (after parsing). */
async function refreshVolatileBase(
  db: Database,
  workspaceId: string,
  baseId: string,
  now: number,
  zonedOnly = false
): Promise<number | null> {
  const inTx = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(db, workspaceId, fn);
  const plan = await inTx(async (tx) => {
    const g = await loadGraph(tx, baseId);
    const byTable = new Map<string, string[]>();
    for (const [id, f] of g.graph.formulas) {
      if (!f.clock || (zonedOnly && !f.clock.zoned)) continue;
      byTable.set(f.field.tableId, [...(byTable.get(f.field.tableId) ?? []), id]);
    }
    return [...byTable].flatMap(([tableId, ids]) => {
      const table = g.tables.get(tableId);
      return table ? [{ table, ids }] : [];
    });
  });
  if (!plan.length) return null;
  const touched = new Map<string, Set<string>>();
  let cells = 0;
  for (const { table, ids } of plan) {
    cells += await recomputeInPages(inTx, table, ids, { touched, now });
  }
  if (touched.size) await inTx((tx) => emitRecomputed(tx, workspaceId, baseId, touched));
  return cells;
}

/** The volatile run for a cron occurrence: zoned formulas only, except on the hour. */
export function volatileRunOf(at: Date): VolatileOptions {
  return { zonedOnly: at.getUTCMinutes() >= 15 };
}
