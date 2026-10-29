import {
  type Base,
  getFieldType,
  interfacePageConfigSchema,
  isFieldTypeName,
  type Template,
  type UserRole,
} from '@openrows/shared';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { physicalName } from '../data/ddl.js';
import { automations, fields } from '../db/index.js';
import type { Entitlements } from '../edition/types.js';
import { parseOptions, type SchemaContext } from '../fields/service.js';
import { createInterface, createPage, publishPage, updatePage } from '../interfaces/service.js';
import { remapIds, type SnapshotHeader } from '../snapshots/format.js';
import { restoreBase, withRowIds } from '../snapshots/restore.js';
import { quotaExceeded } from '../usage/quota.js';

/**
 * Installing a template: the template becomes a snapshot header and the record and link
 * lines of a snapshot file (snapshots/format.ts), and the duplication engine (`restoreBase`
 * ) makes the new base from them under new ids, in the caller's transaction. Formulas
 * written with field names are stored by id before the computed fields are recomputed;
 * automations come along turned off, created by the installer.
 */

/** Field types whose cells a template carries: stored in a column of their own. */
function carriesCells(type: string): boolean {
  if (!isFieldTypeName(type) || type === 'attachment' || type === 'user') return false;
  const def = getFieldType(type);
  return def.storage.kind === 'column' && !def.computed && !def.readOnly;
}

const hex = (id: string) => id.replaceAll('-', '');

/** The template as the header of a snapshot of the target workspace. */
export function templateHeader(template: Template, workspaceId: string, userId: string) {
  // A link and its inverse share one junction, named after whichever of the two comes first.
  const owners = new Map<string, string>();
  for (const t of template.tables) {
    for (const f of t.fields) {
      if (f.type !== 'link' || owners.has(f.id)) continue;
      owners.set(f.id, f.id);
      const inverse = f.options['inverseLinkFieldId'];
      if (typeof inverse === 'string') owners.set(inverse, f.id);
    }
  }
  const head: SnapshotHeader = {
    format: 'openrows.base-snapshot',
    version: 1,
    workspaceId,
    takenAt: new Date().toISOString(),
    base: {
      id: uuidv7(),
      name: template.name,
      description: template.description || null,
      icon: template.icon,
      color: template.color,
    },
    tables: template.tables.map((t, ti) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      icon: null,
      position: ti,
      permissions: {},
      sections: [],
      fields: t.fields.map((f, fi) => {
        if (!isFieldTypeName(f.type)) throw new Error('template: unknown field type');
        const parsed = parseOptions(f.type, f.options) as Record<string, unknown>;
        // A link keeps the template's inverse; the options schema leaves it to the server.
        const config = f.type === 'link' ? { ...parsed, ...pickLink(f.options) } : parsed;
        return {
          id: f.id,
          name: f.name,
          description: f.description,
          type: f.type,
          dbColumn:
            f.type === 'link' ? `l_${hex(owners.get(f.id) ?? f.id)}` : physicalName.column(f.id),
          isPrimary: f.primary,
          position: fi,
          config,
          permissions: {},
        };
      }),
      views: t.views.map((v, vi) => ({
        id: v.id,
        name: v.name,
        type: v.type,
        position: vi,
        config: v.config,
        personal: false,
        locked: false,
        sectionId: null,
        createdBy: userId,
      })),
    })),
  };
  return { head, owners };
}

function pickLink(options: Record<string, unknown>) {
  const { linkedTableId, inverseLinkFieldId } = options;
  return {
    linkedTableId: typeof linkedTableId === 'string' ? linkedTableId : null,
    inverseLinkFieldId: typeof inverseLinkFieldId === 'string' ? inverseLinkFieldId : null,
  };
}

/** The lines after the header: each table's records, then each junction's rows. */
export function* templateLines(
  template: Template,
  owners: ReadonlyMap<string, string>,
  userId: string
): Generator<string> {
  for (const t of template.tables) {
    yield JSON.stringify({ section: 'records', table: t.id });
    for (const r of t.records) {
      const row: Record<string, unknown> = { id: r.id, created_by: userId, updated_by: userId };
      for (const f of t.fields) {
        if (!carriesCells(f.type) || !(f.id in r.cells) || !isFieldTypeName(f.type)) continue;
        const def = getFieldType(f.type);
        const options = def.optionsSchema.parse(f.options);
        const value = def.coerce(r.cells[f.id], options);
        if (value !== null) row[physicalName.column(f.id)] = def.toStorage(value, options);
      }
      yield JSON.stringify(row);
    }
  }
  // Junction rows from either side's cells, from the owner's table to the linked one.
  const tableOf = new Map(template.tables.flatMap((t) => t.fields.map((f) => [f.id, t])));
  const rows = new Map<string, Map<string, { from: string; to: string; p: number; q: number }>>();
  for (const t of template.tables) {
    for (const f of t.fields) {
      if (f.type !== 'link') continue;
      const owner = owners.get(f.id) ?? f.id;
      const isOwner = owner === f.id;
      const pairs = rows.get(owner) ?? new Map();
      rows.set(owner, pairs);
      for (const r of t.records) {
        const linked = r.cells[f.id];
        if (!Array.isArray(linked)) continue;
        linked.forEach((other, i) => {
          if (typeof other !== 'string') return;
          const [from, to] = isOwner ? [r.id, other] : [other, r.id];
          const key = `${from}:${to}`;
          const row = pairs.get(key) ?? { from, to, p: 0, q: 0 };
          if (isOwner) row.p = i;
          else row.q = i;
          pairs.set(key, row);
        });
      }
    }
  }
  for (const [owner, pairs] of rows) {
    if (!pairs.size || !tableOf.has(owner)) continue;
    yield JSON.stringify({ section: 'links', field: owner });
    for (const r of pairs.values()) {
      yield JSON.stringify({ from_id: r.from, to_id: r.to, position: r.p, inverse_position: r.q });
    }
  }
}

async function* lines(items: Iterable<string>): AsyncGenerator<string> {
  yield* items;
}

export interface InstallOptions {
  name?: string | undefined;
  role: UserRole;
  /** The target workspace's plan: records per base, edit permissions. */
  entitlements: Entitlements;
}

/** A new base of the context's workspace from `template`. */
export async function installTemplate(
  ctx: SchemaContext,
  template: Template,
  opts: InstallOptions
): Promise<Base> {
  const records = template.tables.reduce((n, t) => n + t.records.length, 0);
  const max = opts.entitlements.limit('recordsPerBase');
  if (max !== null && records > max) {
    throw quotaExceeded('recordsPerBase', records, max, {
      detail: `This template holds ${records.toLocaleString('en-US')} records, more than the ${max.toLocaleString('en-US')} per base your plan allows.`,
    });
  }
  const { head, owners } = templateHeader(template, ctx.workspaceId, ctx.userId);
  const { tx } = ctx;
  const { base, ids } = await restoreBase(
    ctx,
    undefined,
    head,
    lines(templateLines(template, owners, ctx.userId)),
    {
      name: opts.name ?? template.name,
      role: opts.role,
      keepPermissions: false,
      // Formulas in the template may name fields; stored by id before the recompute.
      // Twice, so a formula over a formula sees the other's result type.
      beforeRefresh: async (map, created) => {
        const { prepareFormula } = await import('../data/computed/engine.js');
        const formulas = template.tables.flatMap((t) =>
          t.fields.filter((f) => f.type === 'formula').map((f) => ({ t, f }))
        );
        for (let pass = 0; pass < (formulas.length > 1 ? 2 : 1); pass++) {
          for (const { t, f } of formulas) {
            const id = map.get(f.id);
            const tableId = map.get(t.id);
            if (!id || !tableId) continue;
            const [row] = await tx.select().from(fields).where(eq(fields.id, id));
            const options = await prepareFormula(tx, created.id, {
              id,
              tableId,
              type: f.type,
              options: row?.config ?? {},
              name: f.name,
            });
            await tx.update(fields).set({ config: options }).where(eq(fields.id, id));
          }
        }
      },
    }
  );
  if (template.automations.length) {
    const map = await withRowIds(
      tx,
      ids,
      template.automations.flatMap((a) => [a.trigger, a.actions])
    );
    await tx.insert(automations).values(
      template.automations.map((a) => {
        const trigger = remapIds(a.trigger, map);
        return {
          id: uuidv7(),
          workspaceId: ctx.workspaceId,
          baseId: base.id,
          name: a.name,
          description: a.description,
          enabled: false,
          trigger,
          actions: remapIds(a.actions, map),
          triggerType: trigger.type,
          tableId: 'tableId' in trigger ? trigger.tableId : null,
          createdBy: ctx.userId,
        };
      })
    );
  }
  if (template.interfaces.length) {
    await installInterfaces(ctx, base.id, template, ids);
  }
  return base;
}

/**
 * The template's interfaces, with their pages published as they are: page configs name
 * the template's tables and fields, stored by the new base's ids and checked as a draft is.
 */
async function installInterfaces(
  ctx: SchemaContext,
  baseId: string,
  template: Template,
  ids: ReadonlyMap<string, string>
) {
  const ictx = { tx: ctx.tx, workspaceId: ctx.workspaceId, baseId, userId: ctx.userId };
  for (const t of template.interfaces) {
    const iface = await createInterface(ictx, { name: t.name });
    for (const p of t.pages) {
      const config = interfacePageConfigSchema.parse(remapIds(p.config, ids));
      const page = await createPage(ictx, iface.id, {
        name: p.name,
        layout: config.layout,
        tableId: config.tableId,
      });
      await updatePage(ictx, iface.id, page.id, { draft: config });
      await publishPage(ictx, iface.id, page.id);
    }
  }
}
