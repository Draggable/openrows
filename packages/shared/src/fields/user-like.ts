import { z } from 'zod';
import type { FieldTypeDef, SystemColumn } from './types.js';
import { compareNullable, defineFieldType, first } from './util.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A user id (lowercase UUID) from a string or a `{ id }` object, else `null`. */
export function readUserId(input: unknown): string | null {
  const v = first(input);
  const id =
    typeof v === 'string'
      ? v
      : typeof v === 'object' && v !== null && 'id' in v && typeof v.id === 'string'
        ? v.id
        : null;
  if (id === null) return null;
  const lower = id.trim().toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

interface UserLikeSpec {
  name: string;
  label: string;
  column: Extract<SystemColumn, 'created_by' | 'updated_by'>;
}

/**
 * A user read from a system column: createdBy, lastModifiedBy. The value is the user id; `format`
 * shows the name from `FormatContext.userName` (the collaborator directory). `compare`
 * orders ids; the query engine sorts by display name, reading `users` (compile.ts `userNameExpr`).
 */
export function userLike(spec: UserLikeSpec): FieldTypeDef<Record<string, never>, string> {
  return defineFieldType<Record<string, never>, string>({
    name: spec.name,
    label: spec.label,
    category: 'people',
    optionsSchema: z.object({}).strict(),
    storage: { kind: 'system', column: spec.column, sqlType: 'uuid' },
    filterOperators: ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'],
    sort: 'text',
    formulaType: 'text',
    editor: { kind: 'none', align: 'left', width: 160 },
    readOnly: true,
    computed: true,
    conversionInput: 'primitive',
    emptyValue: null,
    valueSchema: () => z.string().regex(UUID_RE),
    coerce: readUserId,
    toStorage: (value) => value,
    fromStorage: readUserId,
    compare: (a, b) => compareNullable(a, b, (x, y) => (x < y ? -1 : x > y ? 1 : 0)),
    format: (value, _o, ctx) => (value === null ? '' : (ctx?.userName?.(value) ?? '')),
    toPrimitive: (value) => value,
    apiValue: (value, _o, ctx) => ctx.user(value),
  });
}
