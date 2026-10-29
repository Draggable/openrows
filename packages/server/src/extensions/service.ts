import {
  builtInExtension,
  EXTENSION_LIMITS,
  type ExtensionBundleResponse,
  type ExtensionInstallation,
  type ExtensionManifest,
  type ExtensionSize,
  extensionManifestSchema,
  type InstallExtensionInput,
  installExtensionSchema,
  roleAllows,
  type UpdateExtensionInput,
  type UserRole,
} from '@openrows/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { baseExtensions, type Transaction } from '../db/index.js';
import { AppError } from '../lib/errors.js';

/**
 * Installed extensions: a base's extension panel. The server stores installations, their
 * order, size and settings, and third-party bundles; extensions run in the browser's sandbox
 * (shared's extensions/), whose calls go through the normal API as the person viewing them.
 * Queries run in the resource route's transaction, so RLS applies.
 */

/** Who may install third-party bundles (EXTENSIONS_CUSTOM_BUNDLES). */
export type CustomBundlePolicy = 'creators' | 'owners' | 'off';

export interface ExtensionContext {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  userId: string;
  role: UserRole | null;
}

type ExtensionRow = typeof baseExtensions.$inferSelect;

/** May someone with `role` install a third-party bundle under `policy`? */
export function mayInstallCustom(policy: CustomBundlePolicy, role: UserRole | null): boolean {
  if (!role || !roleAllows(role, 'base:manage_extensions')) return false;
  if (policy === 'off') return false;
  if (policy === 'owners') return role === 'owner';
  return true;
}

/** A built-in's manifest is always shared's (it updates with the app). */
function manifestOf(row: ExtensionRow): ExtensionManifest {
  const builtIn = row.builtIn ? builtInExtension(row.builtIn) : null;
  if (builtIn) return builtIn.manifest;
  return extensionManifestSchema.parse(row.manifest);
}

function toInstallation(row: ExtensionRow): ExtensionInstallation {
  return {
    id: row.id,
    baseId: row.baseId,
    builtIn: row.builtIn,
    name: row.name,
    manifest: manifestOf(row),
    size: row.size as ExtensionSize,
    position: row.position,
    settings: (row.settings ?? {}) as Record<string, unknown>,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listExtensions(
  tx: Transaction,
  baseId: string
): Promise<ExtensionInstallation[]> {
  const rows = await tx
    .select()
    .from(baseExtensions)
    .where(eq(baseExtensions.baseId, baseId))
    .orderBy(asc(baseExtensions.position), asc(baseExtensions.id));
  return rows.map(toInstallation);
}

async function loadExtension(
  tx: Transaction,
  baseId: string,
  extensionId: string
): Promise<ExtensionRow> {
  const [row] = await tx
    .select()
    .from(baseExtensions)
    .where(and(eq(baseExtensions.baseId, baseId), eq(baseExtensions.id, extensionId)));
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such extension in this base.' });
  return row;
}

/** What the frame runs: a built-in's from shared, a third-party one's as stored. */
export async function getExtensionBundle(
  tx: Transaction,
  baseId: string,
  extensionId: string
): Promise<ExtensionBundleResponse> {
  const row = await loadExtension(tx, baseId, extensionId);
  const builtIn = row.builtIn ? builtInExtension(row.builtIn) : null;
  if (builtIn) return { manifest: builtIn.manifest, bundle: builtIn.bundle };
  if (row.builtIn) {
    // A built-in this version no longer ships: nothing to run.
    throw new AppError('NOT_FOUND', { detail: 'This extension is no longer available.' });
  }
  const bundle = (row.bundle ?? {}) as Partial<Record<'html' | 'css' | 'js', unknown>>;
  return {
    manifest: manifestOf(row),
    bundle: {
      html: typeof bundle.html === 'string' ? bundle.html : '',
      css: typeof bundle.css === 'string' ? bundle.css : '',
      js: typeof bundle.js === 'string' ? bundle.js : '',
    },
  };
}

export async function installExtension(
  ctx: ExtensionContext,
  input: InstallExtensionInput,
  policy: CustomBundlePolicy
): Promise<ExtensionInstallation> {
  const body = installExtensionSchema.parse(input);
  let builtIn: string | null = null;
  let manifest: ExtensionManifest;
  let bundle: unknown = null;
  if ('builtIn' in body) {
    const ext = builtInExtension(body.builtIn);
    if (!ext) throw new AppError('NOT_FOUND', { detail: 'No such built-in extension.' });
    builtIn = ext.key;
    manifest = ext.manifest;
  } else {
    if (!mayInstallCustom(policy, ctx.role)) {
      throw new AppError('FORBIDDEN', {
        detail:
          policy === 'off'
            ? 'This server only allows built-in extensions.'
            : policy === 'owners'
              ? 'Only workspace owners can install third-party extensions here.'
              : 'Only creators and owners can install third-party extensions.',
      });
    }
    manifest = body.manifest;
    bundle = body.bundle;
  }
  // One install at a time per base past this point, so the cap and positions hold under
  // concurrent installs.
  await ctx.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`extensions:${ctx.baseId}`}, 0))`
  );
  const [stats] = await ctx.tx
    .select({
      count: sql<number>`count(*)::int`,
      last: sql<number | null>`max(${baseExtensions.position})`,
    })
    .from(baseExtensions)
    .where(eq(baseExtensions.baseId, ctx.baseId));
  if ((stats?.count ?? 0) >= EXTENSION_LIMITS.maxPerBase) {
    throw new AppError('CONFLICT', {
      detail: `A base can have at most ${EXTENSION_LIMITS.maxPerBase} extensions.`,
    });
  }
  const [row] = await ctx.tx
    .insert(baseExtensions)
    .values({
      id: uuidv7(),
      workspaceId: ctx.workspaceId,
      baseId: ctx.baseId,
      builtIn,
      name: manifest.name,
      manifest,
      bundle,
      settings: {},
      size: 'medium',
      position: (stats?.last ?? -1) + 1,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    })
    .returning();
  if (!row) throw new Error('extension insert returned nothing');
  return toInstallation(row);
}

export async function updateExtension(
  ctx: ExtensionContext,
  extensionId: string,
  input: UpdateExtensionInput
): Promise<ExtensionInstallation> {
  await loadExtension(ctx.tx, ctx.baseId, extensionId);
  const [row] = await ctx.tx
    .update(baseExtensions)
    .set({ ...input, updatedBy: ctx.userId, updatedAt: new Date() })
    .where(and(eq(baseExtensions.baseId, ctx.baseId), eq(baseExtensions.id, extensionId)))
    .returning();
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such extension in this base.' });
  return toInstallation(row);
}

/** Puts the panel in `ids`' order: every installed extension's id, once. */
export async function reorderExtensions(
  ctx: ExtensionContext,
  ids: readonly string[]
): Promise<ExtensionInstallation[]> {
  await ctx.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`extensions:${ctx.baseId}`}, 0))`
  );
  const current = await listExtensions(ctx.tx, ctx.baseId);
  const known = new Set(current.map((e) => e.id));
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== known.size ||
    ids.some((id) => !known.has(id))
  ) {
    throw new AppError('VALIDATION_FAILED', {
      detail: "List each of the base's extensions once.",
    });
  }
  for (const [position, id] of ids.entries()) {
    await ctx.tx
      .update(baseExtensions)
      .set({ position })
      .where(and(eq(baseExtensions.baseId, ctx.baseId), eq(baseExtensions.id, id)));
  }
  return listExtensions(ctx.tx, ctx.baseId);
}

export async function setExtensionSettings(
  ctx: ExtensionContext,
  extensionId: string,
  settings: Record<string, unknown>
): Promise<ExtensionInstallation> {
  const current = await loadExtension(ctx.tx, ctx.baseId, extensionId);
  // Only an extension whose manifest asks for settings:write has settings to change (the host
  // refuses it in the browser too).
  if (!manifestOf(current).scopes.includes('settings:write')) {
    throw new AppError('FORBIDDEN', {
      detail: "This extension's manifest doesn't ask for settings:write.",
    });
  }
  const [row] = await ctx.tx
    .update(baseExtensions)
    .set({ settings, updatedBy: ctx.userId, updatedAt: new Date() })
    .where(and(eq(baseExtensions.baseId, ctx.baseId), eq(baseExtensions.id, extensionId)))
    .returning();
  if (!row) throw new AppError('NOT_FOUND', { detail: 'No such extension in this base.' });
  return toInstallation(row);
}

export async function deleteExtension(ctx: ExtensionContext, extensionId: string): Promise<void> {
  const rows = await ctx.tx
    .delete(baseExtensions)
    .where(and(eq(baseExtensions.baseId, ctx.baseId), eq(baseExtensions.id, extensionId)))
    .returning({ id: baseExtensions.id });
  if (rows.length === 0) {
    throw new AppError('NOT_FOUND', { detail: 'No such extension in this base.' });
  }
}
