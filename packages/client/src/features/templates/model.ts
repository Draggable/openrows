import {
  getFieldType,
  isFieldTypeName,
  type Template,
  type TemplateField,
  type TemplateSummary,
} from '@openrows/shared';

/** The gallery's category chips: "All", then each category once, in the templates' order. */
export function categoriesOf(templates: readonly TemplateSummary[]): string[] {
  return ['All', ...new Set(templates.map((t) => t.category))];
}

export function inCategory(templates: readonly TemplateSummary[], category: string) {
  return category === 'All' ? templates : templates.filter((t) => t.category === category);
}

/** "3 tables · 25 records" */
export function templateStats(t: TemplateSummary): string {
  const records = t.tables.reduce((n, x) => n + x.records, 0);
  const tables = `${t.tables.length} ${t.tables.length === 1 ? 'table' : 'tables'}`;
  return `${tables} · ${records} ${records === 1 ? 'record' : 'records'}`;
}

export function fieldTypeLabel(f: TemplateField): string {
  return isFieldTypeName(f.type) ? getFieldType(f.type).label : f.type;
}

export interface PreviewTable {
  name: string;
  fields: { id: string; name: string; type: string; label: string }[];
  /** The first records' cells as display text, by field id. */
  rows: { id: string; cells: Record<string, string> }[];
  records: number;
}

/**
 * A template's table as the preview shows it: its fields, and the first `limit` records as text
 * (link cells by the linked records' primary values; computed fields are blank until installed).
 */
export function previewTable(template: Template, index: number, limit = 6): PreviewTable | null {
  const table = template.tables[index];
  if (!table) return null;
  const primaryText = new Map<string, string>();
  for (const t of template.tables) {
    const primary = t.fields.find((f) => f.primary);
    for (const r of t.records) {
      const v = primary ? r.cells[primary.id] : undefined;
      primaryText.set(r.id, typeof v === 'string' ? v : 'Unnamed record');
    }
  }
  const text = (f: TemplateField, value: unknown): string => {
    if (value === undefined || value === null || !isFieldTypeName(f.type)) return '';
    if (f.type === 'link') {
      return (Array.isArray(value) ? value : [])
        .map((id) => primaryText.get(String(id)) ?? 'Unnamed record')
        .join(', ');
    }
    const def = getFieldType(f.type);
    const options = def.optionsSchema.safeParse(f.options);
    if (!options.success) return '';
    return def.format(def.coerce(value, options.data) as never, options.data as never);
  };
  return {
    name: table.name,
    fields: table.fields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      label: fieldTypeLabel(f),
    })),
    rows: table.records.slice(0, limit).map((r) => ({
      id: r.id,
      cells: Object.fromEntries(table.fields.map((f) => [f.id, text(f, r.cells[f.id])])),
    })),
    records: table.records.length,
  };
}
