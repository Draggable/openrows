import {
  getFieldType,
  isFieldTypeName,
  MAX_TEMPLATE_INTERFACE_PAGES,
  MAX_TEMPLATE_INTERFACES,
  MAX_TEMPLATE_RECORDS,
  MAX_TEMPLATE_RECORDS_PER_TABLE,
  MAX_TEMPLATE_VIEWS,
  TEMPLATE_FORMAT,
  TEMPLATE_VERSION,
  type Template,
  TemplateAutomationSchema,
  TemplateInterfaceSchema,
  TemplateSchema,
} from '@openrows/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { qualified } from '../data/columns.js';
import { physicalName } from '../data/ddl.js';
import { automations, interfacePages, interfaces, type Transaction } from '../db/index.js';
import { readHeader } from '../snapshots/writer.js';

/**
 * "Save as template": a base in the template format, to keep, share or add to a
 * self-hosted server's built-in templates. Tables, fields, the views everyone sees (no personal
 * ones), automations without secrets, and up to MAX_TEMPLATE_RECORDS_PER_TABLE records per
 * table (MAX_TEMPLATE_RECORDS in all, oldest first) with their links. Files, people and computed
 * values stay behind: installing recomputes the computed ones.
 */

/** A slug for the template from the base's name. */
export function templateSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'template';
}

function carriesCells(type: string): boolean {
  if (!isFieldTypeName(type) || type === 'attachment' || type === 'user') return false;
  const def = getFieldType(type);
  return def.storage.kind === 'column' && !def.computed && !def.readOnly;
}

const trim = (s: string | null, max: number) => (s === null ? null : s.slice(0, max));

export async function baseToTemplate(
  tx: Transaction,
  workspaceId: string,
  baseId: string
): Promise<Template> {
  const { head, tableRows } = await readHeader(tx, workspaceId, baseId);
  const location = new Map(tableRows.map((t) => [t.id, t]));
  let budget = MAX_TEMPLATE_RECORDS;

  const cellsOf = new Map<string, Map<string, Record<string, unknown>>>();
  for (const table of head.tables) {
    const t = location.get(table.id);
    const limit = Math.min(MAX_TEMPLATE_RECORDS_PER_TABLE, budget);
    const records = new Map<string, Record<string, unknown>>();
    cellsOf.set(table.id, records);
    if (!t || limit <= 0) continue;
    const { rows } = await tx.execute<{ j: Record<string, unknown> }>(sql`
      SELECT to_jsonb(r) AS j FROM ${qualified(t)} AS r
       WHERE r.deleted_at IS NULL ORDER BY r.id LIMIT ${limit}`);
    budget -= rows.length;
    for (const { j } of rows) {
      const cells: Record<string, unknown> = {};
      for (const f of table.fields) {
        if (!carriesCells(f.type) || !isFieldTypeName(f.type)) continue;
        const def = getFieldType(f.type);
        const options = def.optionsSchema.safeParse(f.config ?? {});
        if (!options.success) continue;
        const value = def.fromStorage(j[f.dbColumn] ?? null, options.data);
        if (value !== null && value !== undefined) cells[f.id] = value;
      }
      records.set(String(j['id']), cells);
    }
  }

  // Links between records that came along, on the owner's side, in the owner's order.
  for (const table of head.tables) {
    for (const f of table.fields) {
      if (f.type !== 'link' || f.dbColumn !== physicalName.junction(f.id)) continue;
      const linkedId = (f.config as { linkedTableId?: string } | null)?.linkedTableId;
      const from = location.get(table.id);
      const fromRecords = cellsOf.get(table.id);
      const toRecords = linkedId ? cellsOf.get(linkedId) : undefined;
      if (!from || !fromRecords?.size || !toRecords?.size) continue;
      const fromIds = `{${[...fromRecords.keys()].join(',')}}`;
      const toIds = `{${[...toRecords.keys()].join(',')}}`;
      const junction = sql`${sql.identifier(from.dbSchema)}.${sql.identifier(f.dbColumn)}`;
      const { rows } = await tx.execute<{ from_id: string; to_id: string }>(sql`
        SELECT j.from_id::text, j.to_id::text FROM ${junction} AS j
         WHERE j.from_id = ANY(${fromIds}::uuid[]) AND j.to_id = ANY(${toIds}::uuid[])
         ORDER BY j.from_id, j.position, j.to_id`);
      for (const r of rows) {
        const cells = fromRecords.get(r.from_id);
        if (!cells) continue;
        const list = (cells[f.id] as string[] | undefined) ?? [];
        if (list.length < 1000) list.push(r.to_id);
        cells[f.id] = list;
      }
    }
  }

  const autoRows = await tx
    .select()
    .from(automations)
    .where(eq(automations.baseId, baseId))
    .orderBy(asc(automations.createdAt), asc(automations.id));
  const autos = autoRows.flatMap((a) => {
    const parsed = TemplateAutomationSchema.safeParse({
      name: a.name,
      description: (a.description ?? '').slice(0, 1000),
      trigger: a.trigger,
      actions: a.actions,
    });
    return parsed.success ? [parsed.data] : [];
  });

  // Interfaces: their published pages, as viewers see them.
  const ifaceRows = await tx
    .select()
    .from(interfaces)
    .where(eq(interfaces.baseId, baseId))
    .orderBy(asc(interfaces.position), asc(interfaces.createdAt));
  const pageRows = ifaceRows.length
    ? await tx
        .select()
        .from(interfacePages)
        .where(
          inArray(
            interfacePages.interfaceId,
            ifaceRows.map((i) => i.id)
          )
        )
        .orderBy(asc(interfacePages.position), asc(interfacePages.createdAt))
    : [];
  const ifaces = ifaceRows.flatMap((i) => {
    const parsed = TemplateInterfaceSchema.safeParse({
      name: i.name,
      pages: pageRows
        .filter((p) => p.interfaceId === i.id && p.published !== null)
        .slice(0, MAX_TEMPLATE_INTERFACE_PAGES)
        .map((p) => ({ name: p.name, config: p.published })),
    });
    return parsed.success ? [parsed.data] : [];
  });

  return TemplateSchema.parse({
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    slug: templateSlug(head.base.name),
    name: head.base.name.slice(0, 255),
    description: trim(head.base.description, 2000) ?? '',
    category: 'Custom',
    icon: trim(head.base.icon, 50),
    color: head.base.color && /^#[0-9A-Fa-f]{6}$/.test(head.base.color) ? head.base.color : null,
    tables: head.tables.map((t) => {
      const shared = t.views.filter((v) => !v.personal);
      return {
        id: t.id,
        name: t.name.slice(0, 255),
        description: trim(t.description, 2000),
        fields: t.fields
          .filter((f) => isFieldTypeName(f.type))
          .map((f) => ({
            id: f.id,
            name: f.name.slice(0, 255),
            description: trim(f.description, 2000),
            type: f.type,
            primary: f.isPrimary,
            options: (f.config ?? {}) as Record<string, unknown>,
          })),
        views: shared.length
          ? shared.slice(0, MAX_TEMPLATE_VIEWS).map((v) => ({
              id: v.id,
              name: v.name.slice(0, 255),
              type: v.type,
              config: (v.config ?? {}) as Record<string, unknown>,
            }))
          : [{ id: uuidv7(), name: 'Grid view', type: 'grid', config: {} }],
        records: [...(cellsOf.get(t.id) ?? new Map()).entries()].map(([id, cells]) => ({
          id,
          cells,
        })),
      };
    }),
    automations: autos.slice(0, 20),
    interfaces: ifaces.slice(0, MAX_TEMPLATE_INTERFACES),
  });
}
