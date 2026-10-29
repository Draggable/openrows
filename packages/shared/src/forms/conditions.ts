import { type Choice, matchChoice } from '../fields/choices.js';
import { instantInZone } from '../fields/datetime.js';
import { getFieldType, isFieldTypeName } from '../fields/index.js';
import type { FieldTypeDef } from '../fields/types.js';
import {
  type FilterCondition,
  type FilterGroup,
  type FilterSubgroup,
  isFilterSubgroup,
} from '../query/index.js';

/**
 * Filter conditions evaluated in memory, over values being typed into a form: a form
 * field shows when its condition matches the values of the fields above it. The semantics
 * follow the view query compiler (`packages/server/src/data/query/compile.ts`): text compares
 * ignoring case, dates by day (datetimes in their field's zone), choices by id or name, and a
 * condition whose value is blank is ignored. Only the types a form can hold are covered; a
 * condition on anything else is ignored.
 */

export interface ConditionField {
  id: string;
  type: string;
  options?: unknown;
}

export interface ConditionContext {
  /** Now, for `today`; defaults to the current time. */
  now?: Date;
  /** The zone of `today` for date-only fields; defaults to UTC. */
  timeZone?: string;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function shiftDay(day: string, days: number, months = 0, years = 0): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years, d.getUTCMonth() + months, d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIn(tz: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function readDay(value: unknown, today: string): string | null {
  if (value === 'today') return today;
  if (value === 'tomorrow') return shiftDay(today, 1);
  if (value === 'yesterday') return shiftDay(today, -1);
  if (typeof value !== 'string') return null;
  const m = DAY_RE.exec(value.trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : null;
}

function readRange(value: unknown, today: string): [string, string] | null {
  switch (value) {
    case 'pastWeek':
      return [shiftDay(today, -7), today];
    case 'pastMonth':
      return [shiftDay(today, 0, -1), today];
    case 'pastYear':
      return [shiftDay(today, 0, 0, -1), today];
    case 'nextWeek':
      return [today, shiftDay(today, 7)];
    case 'nextMonth':
      return [today, shiftDay(today, 0, 1)];
    case 'nextYear':
      return [today, shiftDay(today, 0, 0, 1)];
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as { pastDays?: unknown; nextDays?: unknown };
    const n = v.pastDays ?? v.nextDays;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000) return null;
    return v.pastDays !== undefined ? [shiftDay(today, -n), today] : [today, shiftDay(today, n)];
  }
  return null;
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

function readNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return null;
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

/** The ids a value names: strings, or the `id` of objects (links, attachments). */
function idsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return typeof value === 'string' ? [value] : [];
  return value.flatMap((v) => {
    if (typeof v === 'string') return [v];
    if (typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string') {
      return [(v as { id: string }).id];
    }
    return [];
  });
}

function choiceIdsOf(options: unknown, value: unknown): string[] | null {
  const choices = (options as { choices?: Choice[] } | undefined)?.choices ?? [];
  const out: string[] = [];
  for (const item of list(value)) {
    if (typeof item !== 'string') return null;
    out.push(matchChoice(item, choices) ?? item);
  }
  return out;
}

function setOp(op: string, have: readonly string[], want: readonly string[]): boolean | null {
  const lower = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const h = lower(have);
  const w = lower(want);
  const any = [...w].some((x) => h.has(x));
  switch (op) {
    case 'hasAnyOf':
    case 'isAnyOf':
      return any;
    case 'hasNoneOf':
    case 'isNoneOf':
      return !any;
    case 'hasAllOf':
      return [...w].every((x) => h.has(x));
    case 'isExactly':
      return h.size === w.size && [...w].every((x) => h.has(x));
  }
  return null;
}

/** The text a text-like value matches on (single line, long text, email, URL, phone, barcode). */
function textOf(def: FieldTypeDef, value: unknown, options: unknown): string {
  if (value === null || value === undefined) return '';
  const p = def.toPrimitive(def.coerce(value, options), options);
  return typeof p === 'string' ? p : '';
}

/** One condition: `null` when it's ignored (blank value, unknown field or operator). */
function conditionMatches(
  cond: FilterCondition,
  values: Readonly<Record<string, unknown>>,
  byId: ReadonlyMap<string, ConditionField>,
  ctx: Required<ConditionContext>
): boolean | null {
  const field = byId.get(cond.fieldId);
  if (!field || !isFieldTypeName(field.type)) return null;
  const def = getFieldType(field.type);
  if (!def.filterOperators.includes(cond.operator)) return null;
  const options = def.optionsSchema.safeParse(field.options ?? {}).data ?? {};
  const raw = values[field.id];
  const empty = isBlank(raw) || (def.editor.kind === 'checkbox' && raw !== true);
  const { operator: op, value } = cond;
  if (op === 'isEmpty') return empty;
  if (op === 'isNotEmpty') return !empty;
  if (isBlank(value)) return null;

  switch (def.editor.kind) {
    case 'checkbox': {
      const b = readBoolean(value);
      return b === null ? null : (raw === true) === b;
    }
    case 'number':
    case 'duration':
    case 'rating': {
      const want = readNumber(value);
      if (want === null) return null;
      const have = readNumber(raw);
      if (op === '!=') return have === null || have !== want;
      if (have === null) return false;
      switch (op) {
        case '=':
          return have === want;
        case '<':
          return have < want;
        case '<=':
          return have <= want;
        case '>':
          return have > want;
        case '>=':
          return have >= want;
      }
      return null;
    }
    case 'date':
    case 'dateTime': {
      const zone =
        def.editor.kind === 'dateTime'
          ? ((options as { timeZone?: string }).timeZone ?? 'UTC')
          : ctx.timeZone;
      const today = todayIn(zone, ctx.now);
      let day: string | null = null;
      if (typeof raw === 'string' && raw !== '') {
        day =
          def.editor.kind === 'dateTime' && !Number.isNaN(Date.parse(raw))
            ? instantInZone(new Date(raw).toISOString(), zone).slice(0, 10)
            : readDay(raw, today);
      }
      if (op === 'isWithin') {
        const range = readRange(value, today);
        if (!range) return null;
        return day !== null && day >= range[0] && day <= range[1];
      }
      const want = readDay(value, today);
      if (!want) return null;
      if (op === 'isNot') return day === null || day !== want;
      if (day === null) return false;
      switch (op) {
        case 'is':
          return day === want;
        case 'isBefore':
          return day < want;
        case 'isOnOrBefore':
          return day <= want;
        case 'isAfter':
          return day > want;
        case 'isOnOrAfter':
          return day >= want;
      }
      return null;
    }
    case 'singleSelect': {
      const want = choiceIdsOf(options, value);
      if (!want) return null;
      const have = typeof raw === 'string' ? (choiceIdsOf(options, raw) ?? []) : [];
      if (op === 'is' || op === 'isNot') {
        if (want.length !== 1) return null;
        const same = have[0] !== undefined && have[0] === want[0];
        return op === 'is' ? same : !same;
      }
      return setOp(op, have, want);
    }
    case 'multipleSelect': {
      const want = choiceIdsOf(options, value);
      if (!want) return null;
      return setOp(op, choiceIdsOf(options, idsOf(raw)) ?? [], want);
    }
    case 'user':
    case 'link': {
      if ((op === 'contains' || op === 'doesNotContain') && typeof value === 'string') {
        const names = Array.isArray(raw)
          ? raw.map((v) => String((v as { name?: unknown })?.name ?? '').toLowerCase())
          : [];
        const hit = names.some((n) => n.includes(value.toLowerCase()));
        return op === 'contains' ? hit : !hit;
      }
      const want = list(value).filter((v): v is string => typeof v === 'string');
      if (op === 'is' || op === 'isNot') {
        const same = idsOf(raw)[0]?.toLowerCase() === want[0]?.toLowerCase();
        return op === 'is' ? same : !same;
      }
      return setOp(op, idsOf(raw), want);
    }
    case 'attachment': {
      if (typeof value !== 'string') return null;
      const names = Array.isArray(raw)
        ? raw.map((v) => String((v as { filename?: unknown })?.filename ?? '').toLowerCase())
        : [];
      const hit = names.some((n) => n.includes(value.toLowerCase()));
      if (op === 'contains') return hit;
      if (op === 'doesNotContain') return !hit;
      return null;
    }
    default: {
      if (typeof value !== 'string') return null;
      const text = textOf(def, raw, options).toLowerCase();
      const want = value.toLowerCase();
      switch (op) {
        case 'is':
          return text === want;
        case 'isNot':
          return text !== want;
        case 'contains':
          return text.includes(want);
        case 'doesNotContain':
          return !text.includes(want);
      }
      return null;
    }
  }
}

function join(results: (boolean | null)[], conjunction: 'and' | 'or'): boolean | null {
  const applied = results.filter((r): r is boolean => r !== null);
  if (applied.length === 0) return null;
  return conjunction === 'and' ? applied.every(Boolean) : applied.some(Boolean);
}

/**
 * Whether `values` (field id → value) match the filter. Ignored conditions (blank values) don't
 * count; a filter with nothing left to apply matches.
 */
export function matchesFilter(
  filter: FilterGroup | null | undefined,
  values: Readonly<Record<string, unknown>>,
  fields: readonly ConditionField[],
  context: ConditionContext = {}
): boolean {
  if (!filter) return true;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const ctx = { now: context.now ?? new Date(), timeZone: context.timeZone ?? 'UTC' };
  const one = (entry: FilterCondition | FilterSubgroup): boolean | null =>
    isFilterSubgroup(entry)
      ? join(
          entry.conditions.map((c) => conditionMatches(c, values, byId, ctx)),
          entry.conjunction
        )
      : conditionMatches(entry, values, byId, ctx);
  return join(filter.conditions.map(one), filter.conjunction) ?? true;
}
