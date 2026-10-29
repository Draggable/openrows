import { z } from 'zod';
import { VIEW_TYPES } from '../constants/index.js';
import { FIELD_TYPE_NAMES, getFieldType } from '../fields/index.js';
import { automationActionSchema, automationTriggerSchema } from '../schemas/automation.js';
import { interfacePageConfigSchema } from '../schemas/interface.js';

/**
 * The template format: a base's tables, fields, views, sample records and (optionally)
 * automations as one versioned JSON document. The built-in templates are written in it (through
 * `defineTemplate`), "Save as template" exports a base in it, and installing one turns it into a
 * new base with the duplication engine (the server's templates/install.ts).
 *
 * Ids are UUIDs local to the document: options, view configs, formulas and automations name
 * tables, fields, views and records by them, and the install gives everything new ids. Cells are
 * keyed by field id and hold values the way a user would type them (choice names or ids, numbers,
 * ISO dates); link cells hold the ids of records of the linked table. Computed fields, files and
 * people aren't stored in cells.
 */
export const TEMPLATE_FORMAT = 'openrows.template';
export const TEMPLATE_VERSION = 1;

/** Caps of a template (a sample of a base, never a whole big one). */
export const MAX_TEMPLATE_TABLES = 50;
export const MAX_TEMPLATE_FIELDS = 500;
export const MAX_TEMPLATE_VIEWS = 100;
export const MAX_TEMPLATE_RECORDS_PER_TABLE = 1000;
export const MAX_TEMPLATE_RECORDS = 5000;
export const MAX_TEMPLATE_AUTOMATIONS = 20;
export const MAX_TEMPLATE_INTERFACES = 5;
export const MAX_TEMPLATE_INTERFACE_PAGES = 10;

const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000).nullable().default(null);

export const TEMPLATE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const TemplateFieldSchema = z.strictObject({
  id: z.uuid(),
  name,
  description,
  type: z.enum(FIELD_TYPE_NAMES as [string, ...string[]]),
  primary: z.boolean().default(false),
  options: z.record(z.string(), z.unknown()).default({}),
});
export type TemplateField = z.infer<typeof TemplateFieldSchema>;

export const TemplateViewSchema = z.strictObject({
  id: z.uuid(),
  name,
  type: z.enum(VIEW_TYPES),
  config: z.record(z.string(), z.unknown()).default({}),
});
export type TemplateView = z.infer<typeof TemplateViewSchema>;

export const TemplateRecordSchema = z.strictObject({
  id: z.uuid(),
  cells: z.record(z.uuid(), z.unknown()),
});
export type TemplateRecord = z.infer<typeof TemplateRecordSchema>;

export const TemplateTableSchema = z.strictObject({
  id: z.uuid(),
  name,
  description,
  fields: z.array(TemplateFieldSchema).min(1).max(MAX_TEMPLATE_FIELDS),
  views: z.array(TemplateViewSchema).min(1).max(MAX_TEMPLATE_VIEWS),
  records: z.array(TemplateRecordSchema).max(MAX_TEMPLATE_RECORDS_PER_TABLE).default([]),
});
export type TemplateTable = z.infer<typeof TemplateTableSchema>;

export const TemplateAutomationSchema = z.strictObject({
  name,
  description: z.string().max(1000).default(''),
  trigger: automationTriggerSchema,
  actions: z.array(automationActionSchema).max(25).default([]),
});
export type TemplateAutomation = z.infer<typeof TemplateAutomationSchema>;

/**
 * An interface of the template, installed with its pages published; page configs name the
 * template's table and field ids like its automations do.
 */
export const TemplateInterfaceSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  pages: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(100),
        config: interfacePageConfigSchema,
      })
    )
    .min(1)
    .max(MAX_TEMPLATE_INTERFACE_PAGES),
});
export type TemplateInterface = z.input<typeof TemplateInterfaceSchema>;

export const TemplateSchema = z
  .strictObject({
    format: z.literal(TEMPLATE_FORMAT),
    version: z.literal(TEMPLATE_VERSION),
    slug: z.string().max(64).regex(TEMPLATE_SLUG),
    name,
    description: z.string().max(2000).default(''),
    category: z.string().trim().min(1).max(64),
    icon: z.string().max(50).nullable().default(null),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .nullable()
      .default(null),
    tables: z.array(TemplateTableSchema).min(1).max(MAX_TEMPLATE_TABLES),
    automations: z.array(TemplateAutomationSchema).max(MAX_TEMPLATE_AUTOMATIONS).default([]),
    interfaces: z.array(TemplateInterfaceSchema).max(MAX_TEMPLATE_INTERFACES).default([]),
  })
  .superRefine((t, ctx) => {
    for (const problem of templateProblems(t)) ctx.addIssue({ code: 'custom', ...problem });
  });
export type Template = z.infer<typeof TemplateSchema>;
export type TemplateInput = z.input<typeof TemplateSchema>;

/** What a document's shape can't say: unique ids, one primary field, cells of known fields. */
function templateProblems(t: {
  tables: readonly TemplateTable[];
  interfaces?: readonly { pages: readonly { config: { tableId: string } }[] }[];
}): { path: (string | number)[]; message: string }[] {
  const problems: { path: (string | number)[]; message: string }[] = [];
  const tableIds = new Set(t.tables.map((x) => x.id));
  for (const [ii, iface] of (t.interfaces ?? []).entries()) {
    for (const [pi, page] of iface.pages.entries()) {
      if (!tableIds.has(page.config.tableId)) {
        problems.push({
          path: ['interfaces', ii, 'pages', pi, 'config', 'tableId'],
          message: 'Not a table of the template',
        });
      }
    }
  }
  const ids = new Set<string>();
  const unique = (id: string, path: (string | number)[]) => {
    if (ids.has(id)) problems.push({ path, message: `Duplicate id ${id}` });
    ids.add(id);
  };
  let records = 0;
  t.tables.forEach((table, ti) => {
    unique(table.id, ['tables', ti, 'id']);
    const fieldIds = new Set(table.fields.map((f) => f.id));
    for (const [fi, f] of table.fields.entries()) unique(f.id, ['tables', ti, 'fields', fi, 'id']);
    for (const [vi, v] of table.views.entries()) unique(v.id, ['tables', ti, 'views', vi, 'id']);
    const primary = table.fields.filter((f) => f.primary);
    const def = primary[0] ? getFieldType(primary[0].type as never) : null;
    if (primary.length !== 1 || !def || def.computed || primary[0]?.type === 'link') {
      problems.push({
        path: ['tables', ti, 'fields'],
        message: 'A table needs exactly one primary field, which is not computed or a link',
      });
    }
    records += table.records.length;
    table.records.forEach((r, ri) => {
      unique(r.id, ['tables', ti, 'records', ri, 'id']);
      for (const id of Object.keys(r.cells)) {
        if (!fieldIds.has(id)) {
          problems.push({
            path: ['tables', ti, 'records', ri, 'cells', id],
            message: 'Not a field of the table',
          });
        }
      }
    });
  });
  if (records > MAX_TEMPLATE_RECORDS) {
    problems.push({ path: ['tables'], message: `At most ${MAX_TEMPLATE_RECORDS} records` });
  }
  return problems;
}

/** A template as the gallery lists it: no records, no options. */
export const TemplateSummarySchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  tables: z.array(z.object({ name: z.string(), fields: z.number(), records: z.number() })),
  automations: z.number(),
});
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;

export const TemplateListSchema = z.object({ templates: z.array(TemplateSummarySchema) });

export function templateSummary(t: Template): TemplateSummary {
  return {
    slug: t.slug,
    name: t.name,
    description: t.description,
    category: t.category,
    icon: t.icon,
    color: t.color,
    tables: t.tables.map((table) => ({
      name: table.name,
      fields: table.fields.length,
      records: table.records.length,
    })),
    automations: t.automations.length,
  };
}

/** `POST /api/workspaces/:workspaceId/templates`: a new base from a built-in template. */
export const installTemplateSchema = z.strictObject({
  slug: z.string().max(64).regex(TEMPLATE_SLUG),
  name: name.optional(),
});
export type InstallTemplateInput = z.infer<typeof installTemplateSchema>;
