import {
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type FilterOperator,
  type FilterSubgroup,
  getFieldType,
  isFilterSubgroup,
  MAX_FILTER_CONDITIONS,
  type SavedViewQuery,
} from '@openrows/shared';

// Pure helpers of the view toolbar: operator labels, which value input a condition needs,
// counting and editing the filter tree, and the group headers of a grouped grid. Everything
// type-specific comes from the field-type registry (`filterOperators`, `sort`, `editor.kind`).

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: 'is',
  isNot: 'is not',
  contains: 'contains',
  doesNotContain: 'does not contain',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
  '=': '=',
  '!=': '≠',
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
  isBefore: 'is before',
  isAfter: 'is after',
  isOnOrBefore: 'is on or before',
  isOnOrAfter: 'is on or after',
  isWithin: 'is within',
  isAnyOf: 'is any of',
  isNoneOf: 'is none of',
  hasAnyOf: 'has any of',
  hasAllOf: 'has all of',
  hasNoneOf: 'has none of',
  isExactly: 'is exactly',
};

/** Relative dates a date condition can compare with, beside an exact date. */
export const RELATIVE_DATES = ['today', 'tomorrow', 'yesterday'] as const;
export const WITHIN_PRESETS = {
  pastWeek: 'the past week',
  pastMonth: 'the past month',
  pastYear: 'the past year',
  nextWeek: 'the next week',
  nextMonth: 'the next month',
  nextYear: 'the next year',
} as const;

/** The input a condition's value takes. */
export type ValueInput =
  | 'none'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'within'
  | 'choice'
  | 'choices'
  | 'user'
  | 'users'
  | 'records'
  | 'unsupported';

export function valueInputFor(field: FieldMeta, operator: FilterOperator): ValueInput {
  if (operator === 'isEmpty' || operator === 'isNotEmpty') return 'none';
  const def = getFieldType(field.type);
  // Links pick specific records or match the linked records' names as text.
  if (def.editor.kind === 'link') {
    return operator === 'hasAnyOf' || operator === 'hasNoneOf' ? 'records' : 'text';
  }
  // People are picked from the collaborator directory, `me` included.
  if (def.category === 'people')
    return operator === 'is' || operator === 'isNot' ? 'user' : 'users';
  if (def.editor.kind === 'checkbox') return 'boolean';
  if (def.editor.kind === 'singleSelect' || def.editor.kind === 'multipleSelect') {
    return operator === 'is' || operator === 'isNot' ? 'choice' : 'choices';
  }
  if (operator === 'isWithin') return 'within';
  if (def.sort === 'chronological') return 'date';
  if (def.sort === 'number') return 'number';
  return 'text';
}

/** The operators the toolbar offers for a field: the registry's, minus those it can't fill. */
export function operatorsFor(field: FieldMeta): FilterOperator[] {
  return getFieldType(field.type).filterOperators.filter(
    (op) => valueInputFor(field, op) !== 'unsupported'
  );
}

/** A new condition on `field`, with its first operator and an empty value. */
export function newCondition(field: FieldMeta): FilterCondition {
  const operator = operatorsFor(field)[0] ?? 'isNotEmpty';
  const input = valueInputFor(field, operator);
  return { fieldId: field.id, operator, ...(input === 'boolean' ? { value: true } : {}) };
}

/** A condition moved to another operator keeps its value only when the input stays the same. */
export function withOperator(
  field: FieldMeta,
  cond: FilterCondition,
  operator: FilterOperator
): FilterCondition {
  const same = valueInputFor(field, cond.operator) === valueInputFor(field, operator);
  const next: FilterCondition = { fieldId: cond.fieldId, operator };
  if (same && cond.value !== undefined) next.value = cond.value;
  else if (valueInputFor(field, operator) === 'boolean') next.value = true;
  return next;
}

/** Is the condition complete (the server ignores one without a value, as Airtable does)? */
export function isActive(cond: FilterCondition): boolean {
  if (cond.operator === 'isEmpty' || cond.operator === 'isNotEmpty') return true;
  const v = cond.value;
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Conditions in the filter tree (nested ones included). */
export function conditionCount(filter: FilterGroup | undefined): number {
  return (filter?.conditions ?? []).reduce(
    (n, entry) => n + (isFilterSubgroup(entry) ? entry.conditions.length : 1),
    0
  );
}

/** Complete conditions, for the toolbar's "Filter (n)". */
export function activeConditionCount(filter: FilterGroup | undefined): number {
  return (filter?.conditions ?? []).reduce(
    (n, entry) =>
      n + (isFilterSubgroup(entry) ? entry.conditions.filter(isActive).length : +isActive(entry)),
    0
  );
}

export function canAddCondition(filter: FilterGroup | undefined): boolean {
  return conditionCount(filter) < MAX_FILTER_CONDITIONS;
}

export const EMPTY_FILTER: FilterGroup = { conjunction: 'and', conditions: [] };

/** Replaces (or, with `null`, removes) the entry at `index`; an emptied subgroup goes away. */
export function setEntry(
  filter: FilterGroup,
  index: number,
  entry: FilterCondition | FilterSubgroup | null
): FilterGroup {
  const conditions = [...filter.conditions];
  if (entry === null || (isFilterSubgroup(entry) && entry.conditions.length === 0)) {
    conditions.splice(index, 1);
  } else {
    conditions[index] = entry;
  }
  return { ...filter, conditions };
}

/** The view's query as the toolbar edits it, with the defaults filled in. */
export type ToolbarQuery = Required<SavedViewQuery>;

export function toolbarQuery(saved: SavedViewQuery): ToolbarQuery {
  return {
    filter: saved.filter ?? EMPTY_FILTER,
    sorts: saved.sorts ?? [],
    groupBy: saved.groupBy ?? [],
  };
}

/** One group header shown above the first record of its group. */
export type GroupHeader = { level: number; key: unknown; count: number };

/**
 * The headers of a grouped grid by the index of the record they sit above, from the server's
 * leaf groups (in display order, each with its key per level and its record count). A record
 * starting a group at level `d` gets the headers of levels `d` and deeper; each header counts
 * the records of its group.
 */
export function groupHeaders(
  groups: readonly { key: readonly unknown[]; count: number }[]
): Map<number, GroupHeader[]> {
  const out = new Map<number, GroupHeader[]>();
  const open: GroupHeader[] = [];
  let start = 0;
  let prev: readonly unknown[] | null = null;
  for (const g of groups) {
    let level = 0;
    if (prev) {
      while (level < g.key.length && JSON.stringify(g.key[level]) === JSON.stringify(prev[level]))
        level++;
    }
    if (prev && level === g.key.length) level = g.key.length - 1;
    const headers: GroupHeader[] = [];
    for (let d = level; d < g.key.length; d++) {
      const h = { level: d, key: g.key[d], count: 0 };
      open[d] = h;
      headers.push(h);
    }
    for (let d = 0; d < g.key.length; d++) {
      const h = open[d];
      if (h) h.count += g.count;
    }
    if (headers.length > 0 && g.count > 0) out.set(start, headers);
    start += g.count;
    prev = g.key;
  }
  return out;
}

/** Fields a find matches against: the visible ones whose text can be searched. */
export function findMatches(
  term: string,
  fields: readonly FieldMeta[],
  text: (field: FieldMeta) => string
): number[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return [];
  return fields.flatMap((f, i) => (text(f).toLowerCase().includes(needle) ? [i] : []));
}
