import { MAX_RECORDS_PER_REQUEST } from '@openrows/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { inScope } from '../authz/scope.js';
import { createBase } from '../bases/service.js';
import { qualified } from '../data/columns.js';
import { bases, type Database, users, workspaceMembers, workspaces } from '../db/index.js';
import { unlimitedEntitlements } from '../edition/oss.js';
import { createField, liveFields } from '../fields/service.js';
import { createRecords } from '../records/service.js';
import { createTable, liveTables, loadTable } from '../tables/service.js';
import {
  DEMO_BASE_NAME,
  DEMO_WORKSPACE_NAME,
  PRODUCT_ROADMAP,
  random,
  type TemplateTable,
} from './template.js';

export { DEMO_BASE_NAME, DEMO_WORKSPACE_NAME, PRODUCT_ROADMAP } from './template.js';

export interface SeedResult {
  /** False when the user already had the demo workspace, which is then left as it is. */
  created: boolean;
  workspaceId: string;
  baseId: string;
  tables: { id: string; name: string; fields: number; records: number }[];
}

/** The user with this (verified or not) email, case-insensitively; the newest if several. */
export async function findUserByEmail(db: Database, email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .orderBy(sql`${users.createdAt} desc`)
    .limit(1);
  return user;
}

/** The user's demo workspace, if they own one, with its base and tables as they are now. */
async function existingDemo(db: Database, userId: string): Promise<SeedResult | null> {
  const [ws] = await inScope(db, { userId }, (tx) =>
    tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.role, 'owner')
        )
      )
      .where(and(eq(workspaces.name, DEMO_WORKSPACE_NAME), isNull(workspaces.deletedAt)))
      .limit(1)
  );
  if (!ws) return null;
  return inScope(db, { userId, workspaceId: ws.id }, async (tx) => {
    const [base] = await tx
      .select()
      .from(bases)
      .where(and(eq(bases.workspaceId, ws.id), isNull(bases.deletedAt)))
      .orderBy(asc(bases.createdAt))
      .limit(1);
    const result: SeedResult = {
      created: false,
      workspaceId: ws.id,
      baseId: base?.id ?? '',
      tables: [],
    };
    for (const table of base ? await liveTables(tx, base.id) : []) {
      const counted = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${qualified(table)} WHERE deleted_at IS NULL`
      );
      result.tables.push({
        id: table.id,
        name: table.name,
        fields: (await liveFields(tx, table.id)).length,
        records: counted.rows[0]?.n ?? 0,
      });
    }
    return result;
  });
}

/**
 * Creates the "Product Roadmap (demo)" workspace owned by `userId`, with the Product Roadmap base
 * (5 tables, 31 fields, 2,000 records), through the same services the API uses (DDL manager,
 * outbox, RecordService) and under RLS, in one transaction. Idempotent per user: if they already
 * own a workspace of that name, nothing is written.
 */
export async function seedDemo(
  db: Database,
  opts: { userId: string; template?: readonly TemplateTable[]; seed?: number }
): Promise<SeedResult> {
  const { userId } = opts;
  const existing = await existingDemo(db, userId);
  if (existing) return existing;

  const workspaceId = uuidv7();
  const rand = random(opts.seed ?? 32);
  return inScope(db, { userId, workspaceId }, async (tx) => {
    await tx.insert(workspaces).values({ id: workspaceId, name: DEMO_WORKSPACE_NAME });
    await tx.insert(workspaceMembers).values({ workspaceId, userId, role: 'owner' });
    const ctx = { tx, workspaceId, userId };
    const base = await createBase(
      ctx,
      { name: DEMO_BASE_NAME, description: 'Demo data: features, epics, releases and feedback.' },
      'owner'
    );
    const [baseRow] = await tx.select().from(bases).where(eq(bases.id, base.id));
    if (!baseRow) throw new Error('seed: base not visible under RLS');

    const tables: SeedResult['tables'] = [];
    for (const spec of opts.template ?? PRODUCT_ROADMAP) {
      const created = await createTable(ctx, baseRow, { name: spec.name });
      let table = await loadTable(tx, created.id);
      for (const field of spec.fields) await createField(ctx, table, field);
      table = await loadTable(tx, created.id);
      const idByName = new Map((await liveFields(tx, table.id)).map((f) => [f.name, f.id]));
      const rows = Array.from({ length: spec.records }, (_, i) => {
        const cells: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(spec.row(i, rand))) {
          const id = idByName.get(name);
          if (!id) throw new Error(`seed: ${spec.name} has no field "${name}"`);
          if (value !== null) cells[id] = value;
        }
        return cells;
      });
      for (let i = 0; i < rows.length; i += MAX_RECORDS_PER_REQUEST) {
        await createRecords(
          // The seeded workspace is the user's own (they own it); its tables have no restrictions.
          // An operator's tool: the demo base is seeded whole, whatever the plan.
          { tx, workspaceId, userId, role: 'owner', table, entitlements: unlimitedEntitlements() },
          rows.slice(i, i + MAX_RECORDS_PER_REQUEST)
        );
      }
      tables.push({ id: table.id, name: spec.name, fields: idByName.size, records: rows.length });
    }
    return { created: true, workspaceId, baseId: base.id, tables };
  });
}
