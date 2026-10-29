import {
  type CreateScriptInput,
  createScriptSchema,
  MAX_SCRIPTS_PER_BASE,
  type Script,
  type UpdateScriptInput,
} from '@openrows/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { baseScripts, type Transaction } from '../db/index.js';
import { AppError } from '../lib/errors.js';

/**
 * Saved scripts: a base's scripts for the Scripts page. The server only stores them; they
 * run in the browser's sandbox (shared's scripts/), whose calls go through the normal API as the
 * person running them. Queries run in the resource route's transaction, so RLS applies.
 */

export interface ScriptContext {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  userId: string;
}

type ScriptRow = typeof baseScripts.$inferSelect;

function toScript(row: ScriptRow): Script {
  return {
    id: row.id,
    baseId: row.baseId,
    name: row.name,
    description: row.description,
    code: row.code,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listScripts(tx: Transaction, baseId: string): Promise<Script[]> {
  const rows = await tx
    .select()
    .from(baseScripts)
    .where(eq(baseScripts.baseId, baseId))
    .orderBy(asc(sql`lower(${baseScripts.name})`), asc(baseScripts.id));
  return rows.map(toScript);
}

async function loadScript(tx: Transaction, baseId: string, scriptId: string): Promise<ScriptRow> {
  const [row] = await tx
    .select()
    .from(baseScripts)
    .where(and(eq(baseScripts.baseId, baseId), eq(baseScripts.id, scriptId)));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such script in this base.' });
  return row;
}

export async function getScript(tx: Transaction, baseId: string, scriptId: string) {
  return toScript(await loadScript(tx, baseId, scriptId));
}

export async function createScript(ctx: ScriptContext, input: CreateScriptInput): Promise<Script> {
  const body = createScriptSchema.parse(input);
  // One script at a time per base past this point, so the cap holds under concurrent creates.
  await ctx.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`scripts:${ctx.baseId}`}, 0))`
  );
  const [stats] = await ctx.tx
    .select({ count: sql<number>`count(*)::int` })
    .from(baseScripts)
    .where(eq(baseScripts.baseId, ctx.baseId));
  if ((stats?.count ?? 0) >= MAX_SCRIPTS_PER_BASE) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${MAX_SCRIPTS_PER_BASE} scripts.`,
    });
  }
  const [row] = await ctx.tx
    .insert(baseScripts)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      baseId: ctx.baseId,
      name: body.name,
      description: body.description,
      code: body.code,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error('script insert returned nothing');
  return toScript(row);
}

export async function updateScript(
  ctx: ScriptContext,
  scriptId: string,
  input: UpdateScriptInput
): Promise<Script> {
  await loadScript(ctx.tx, ctx.baseId, scriptId);
  const [row] = await ctx.tx
    .update(baseScripts)
    .set({ ...input, updatedBy: ctx.userId, updatedAt: new Date() })
    .where(and(eq(baseScripts.baseId, ctx.baseId), eq(baseScripts.id, scriptId)))
    .returning();
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such script in this base.' });
  return toScript(row);
}

export async function deleteScript(ctx: ScriptContext, scriptId: string): Promise<void> {
  const rows = await ctx.tx
    .delete(baseScripts)
    .where(and(eq(baseScripts.baseId, ctx.baseId), eq(baseScripts.id, scriptId)))
    .returning({ id: baseScripts.id });
  if (rows.length === 0)
    throw new AppError('NOT_FOUND', { detail: 'No such script in this base.' });
}
