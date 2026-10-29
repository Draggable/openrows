import {
  ASSISTANT_SAMPLE_RECORDS,
  type AssistantFieldInfo,
  FORMULA_TYPES,
  type FormulaType,
  getFieldType,
  isFieldTypeName,
} from '@openrows/shared';
import type { Transaction } from '../../db/index.js';
import { type FieldRow, liveFields, type TableRow } from '../../fields/service.js';
import { listRecords } from '../../records/service.js';
import { liveTables } from '../../tables/service.js';
import type { DescribedBase } from './plan.js';

/** What the model reads of a base: enough to plan, capped so a big base still fits a request. */
const MAX_TABLES = 60;
const MAX_FIELDS = 150;
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

function detailOf(row: FieldRow, tableNames: Map<string, string>): string | undefined {
  const c = config(row);
  if (row.type === 'singleSelect' || row.type === 'multipleSelect') {
    const choices = Array.isArray(c['choices']) ? (c['choices'] as { name?: unknown }[]) : [];
    const names = choices.map((x) => String(x.name ?? '')).filter(Boolean);
    const shown = names.slice(0, MAX_CHOICES_SHOWN).map((n) => JSON.stringify(n));
    if (names.length > shown.length) shown.push('…');
    return shown.length ? `options ${shown.join(', ')}` : undefined;
  }
  if (row.type === 'link') {
    const target = tableNames.get(String(c['linkedTableId'] ?? ''));
    return target ? `links to "${target}"` : undefined;
  }
  const resultType = resultTypeOf(row);
  return resultType ? `result ${resultType}` : undefined;
}

function sorted(rows: FieldRow[]): FieldRow[] {
  return [...rows].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

/** The base's tables and fields (primary first), as the plan checker and the model see them. */
export async function describedBase(
  tx: Transaction,
  baseId: string
): Promise<{ base: DescribedBase; tables: TableRow[] }> {
  const tables = (await liveTables(tx, baseId)).slice(0, MAX_TABLES);
  const names = new Map(tables.map((t) => [t.id, t.name]));
  const described: DescribedBase['tables'] = [];
  for (const table of tables) {
    const fields = sorted(await liveFields(tx, table.id)).slice(0, MAX_FIELDS);
    described.push({
      name: table.name,
      fields: fields.map((f) => {
        const info: AssistantFieldInfo = { name: f.name, type: f.type };
        const resultType = resultTypeOf(f);
        if (resultType) info.resultType = resultType;
        const detail = detailOf(f, names);
        if (detail) info.detail = detail;
        return info;
      }),
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
