import {
  ASSISTANT_SAMPLE_RECORDS,
  type AssistantFieldInfo,
  computedSourceOf,
  FORMULA_TYPES,
  type FormulaType,
  fieldFormulaType,
  getFieldType,
  isFieldTypeName,
  TEXT_ROLLUP_FUNCTIONS,
} from '@openrows/shared';
import { loadGraph } from '../../data/computed/engine.js';
import type { Transaction } from '../../db/index.js';
import { type FieldRow, liveFields, type TableRow } from '../../fields/service.js';
import { listRecords } from '../../records/service.js';
import { liveTables } from '../../tables/service.js';
import { liveViews } from '../../views/service.js';
import type { DescribedBase } from './plan.js';

/** What the model reads of a base: enough to plan, capped so a big base still fits a request. */
const MAX_TABLES = 60;
const MAX_FIELDS = 150;
const MAX_VIEWS = 30;
const MAX_CHOICES_SHOWN = 20;
const MAX_SAMPLE_TABLES = 15;
const MAX_CELL_CHARS = 120;

function config(row: FieldRow): Record<string, unknown> {
  return typeof row.config === 'object' && row.config !== null
    ? (row.config as Record<string, unknown>)
    : {};
}

function resultTypeOf(row: FieldRow): FormulaType | undefined {
  const t = config(row)['resultType'];
  return typeof t === 'string' && (FORMULA_TYPES as readonly string[]).includes(t)
    ? (t as FormulaType)
    : undefined;
}

/** The fields of the base by id, and what the checker needs beyond a field's type. */
interface BaseFields {
  byId: Map<string, FieldRow>;
  tableNames: Map<string, string>;
  /** AI fields and the fields computed from them. */
  fromAi: Set<string>;
}

/** Whether a field's values are numbers, for the rollups that read numbers. */
function numericOf(row: FieldRow, base: BaseFields, depth = 0): boolean {
  const c = config(row);
  if (row.type === 'rollup') return !TEXT_ROLLUP_FUNCTIONS.includes(String(c['function'] ?? 'SUM'));
  if (row.type === 'ai') return c['output'] === 'number';
  if (row.type === 'lookup') {
    const sourceId = computedSourceOf(row.type, c)?.sourceFieldId;
    const source = sourceId ? base.byId.get(sourceId) : undefined;
    return source !== undefined && depth < 5 && numericOf(source, base, depth + 1);
  }
  const resultType = resultTypeOf(row);
  return fieldFormulaType({ type: row.type, ...(resultType ? { resultType } : {}) }) === 'number';
}

function linkedTableOf(row: FieldRow, base: BaseFields): string | undefined {
  return row.type === 'link'
    ? base.tableNames.get(String(config(row)['linkedTableId'] ?? ''))
    : undefined;
}

function computedDetail(row: FieldRow, base: BaseFields): string | undefined {
  const c = config(row);
  const src = computedSourceOf(row.type, c);
  if (src) {
    const link = src.linkFieldId ? base.byId.get(src.linkFieldId)?.name : undefined;
    const source = src.sourceFieldId ? base.byId.get(src.sourceFieldId)?.name : undefined;
    if (!link) return undefined;
    if (row.type === 'count') return `counts the records of "${link}"`;
    const of = source ? `"${source}" through "${link}"` : `through "${link}"`;
    return row.type === 'lookup' ? `looks up ${of}` : `${String(c['function'] ?? 'SUM')} of ${of}`;
  }
  if (row.type === 'button') return `button, ${String(c['action'] ?? 'openUrl')}`;
  if (row.type === 'ai') return `AI answer, output ${String(c['output'] ?? 'text')}`;
  return undefined;
}

function detailOf(row: FieldRow, base: BaseFields): string | undefined {
  const parts = [ownDetail(row, base), computedDetail(row, base)];
  if (row.type !== 'ai' && base.fromAi.has(row.id)) parts.push('reads an AI field');
  const detail = parts.filter(Boolean).join('; ');
  return detail || undefined;
}

function ownDetail(row: FieldRow, base: BaseFields): string | undefined {
  const c = config(row);
  if (row.type === 'singleSelect' || row.type === 'multipleSelect') {
    const choices = Array.isArray(c['choices']) ? (c['choices'] as { name?: unknown }[]) : [];
    const names = choices.map((x) => String(x.name ?? '')).filter(Boolean);
    const shown = names.slice(0, MAX_CHOICES_SHOWN).map((n) => JSON.stringify(n));
    if (names.length > shown.length) shown.push('…');
    return shown.length ? `options ${shown.join(', ')}` : undefined;
  }
  if (row.type === 'link') {
    const target = linkedTableOf(row, base);
    return target ? `links to "${target}"` : undefined;
  }
  const resultType = resultTypeOf(row);
  return resultType ? `result ${resultType}` : undefined;
}

function sorted(rows: FieldRow[]): FieldRow[] {
  return [...rows].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

/**
 * The base's tables, fields (primary first) and the views `userId` sees, as the plan checker
 * and the model see them.
 */
export async function describedBase(
  tx: Transaction,
  baseId: string,
  userId: string
): Promise<{ base: DescribedBase; tables: TableRow[] }> {
  const tables = (await liveTables(tx, baseId)).slice(0, MAX_TABLES);
  const g = await loadGraph(tx, baseId);
  const aiIds = [...g.rows.values()].filter((r) => r.type === 'ai').map((r) => r.id);
  const known: BaseFields = {
    byId: g.rows,
    tableNames: new Map(tables.map((t) => [t.id, t.name])),
    fromAi: new Set([...aiIds, ...g.graph.downstream(aiIds)]),
  };
  const described: DescribedBase['tables'] = [];
  for (const table of tables) {
    const fields = sorted(await liveFields(tx, table.id)).slice(0, MAX_FIELDS);
    described.push({
      name: table.name,
      fields: fields.map((f) => {
        const info: AssistantFieldInfo = { name: f.name, type: f.type };
        const resultType = resultTypeOf(f);
        if (resultType) info.resultType = resultType;
        const detail = detailOf(f, known);
        if (detail) info.detail = detail;
        const linkedTable = linkedTableOf(f, known);
        if (linkedTable) info.linkedTable = linkedTable;
        if (['lookup', 'rollup', 'ai'].includes(f.type)) info.numeric = numericOf(f, known);
        if (known.fromAi.has(f.id)) info.fromAi = true;
        if (f.type === 'button') info.buttonAction = String(config(f)['action'] ?? 'openUrl');
        return info;
      }),
      views: (await liveViews(tx, table.id, userId))
        .slice(0, MAX_VIEWS)
        .map((v) => ({ name: v.name, type: v.type })),
    });
  }
  return { base: { tables: described }, tables };
}

function cellText(row: FieldRow, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  let text: string;
  if (isFieldTypeName(row.type)) {
    try {
      text = getFieldType(row.type).format(value as never, config(row) as never);
    } catch {
      text = JSON.stringify(value);
    }
  } else {
    text = JSON.stringify(value);
  }
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

/**
 * A few records of each table, only when the user opted in: read as the user, through the
 * RecordService, with the fields they read. Lines of `Field: value`.
 */
export async function sampleRecords(
  ctx: { tx: Transaction; workspaceId: string; userId: string },
  tables: TableRow[]
): Promise<string> {
  const parts: string[] = [];
  for (const table of tables.slice(0, MAX_SAMPLE_TABLES)) {
    const fields = sorted(await liveFields(ctx.tx, table.id)).slice(0, MAX_FIELDS);
    const { records } = await listRecords({ ...ctx, table }, { limit: ASSISTANT_SAMPLE_RECORDS });
    if (records.length === 0) continue;
    const lines = records.map((r) =>
      fields
        .filter((f) => f.id in r.fields)
        .map((f) => `${f.name}: ${cellText(f, r.fields[f.id])}`)
        .filter((line) => !line.endsWith(': '))
        .join('; ')
    );
    parts.push(`Table "${table.name}":\n${lines.map((l) => `- ${l}`).join('\n')}`);
  }
  return parts.join('\n\n');
}
