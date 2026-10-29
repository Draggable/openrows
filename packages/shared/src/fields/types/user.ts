import { z } from 'zod';
import { readUserId } from '../user-like.js';
import { compareNullable, defineFieldType } from '../util.js';

/** Most people one user cell holds. */
export const MAX_USERS_PER_CELL = 100;

export const userOptionsSchema = z
  .object({
    /** Several people per cell (Airtable's "allow adding multiple collaborators"). */
    multiple: z.boolean().default(false),
    /** Notify people when they're added (M3: mentions and notifications; stored, not acted on). */
    notify: z.boolean().default(false),
  })
  .strict();

export type UserOptions = z.infer<typeof userOptionsSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The user ids an input names: an id, a `{ id }`, or an array of them (text split on commas). */
function readUserIds(input: unknown, o: UserOptions): string[] | null {
  const items = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [input];
  const ids: string[] = [];
  for (const item of items) {
    const id = readUserId(item);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  const capped = ids.slice(0, o.multiple ? MAX_USERS_PER_CELL : 1);
  return capped.length ? capped : null;
}

const compareIds = (a: string[], b: string[]) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
};

/**
 * Collaborators (Airtable's user field): one person, or several with `multiple`. The column is
 * `text[]` of user ids, also for one person, so switching `multiple` keeps the column (turning
 * it off keeps each cell's first person). `coerce` reads any id: the records service only
 * accepts current collaborators of the base on write; a removed member's id stays and
 * shows as "former member". `format` shows names from `FormatContext.userName`; the query engine
 * sorts by the first person's display name, like createdBy.
 */
export const user = defineFieldType({
  name: 'user',
  label: 'User',
  category: 'people',
  optionsSchema: userOptionsSchema,
  storage: { kind: 'column', sqlType: 'text[]', items: 'userIds' },
  filterOperators: ['hasAnyOf', 'hasAllOf', 'isExactly', 'hasNoneOf', 'isEmpty', 'isNotEmpty'],
  sort: 'text',
  formulaType: 'array',
  editor: { kind: 'user', align: 'left', width: 180 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: (o) =>
    z
      .array(z.string().regex(UUID_RE))
      .min(1)
      .max(o.multiple ? MAX_USERS_PER_CELL : 1)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate user'),
  coerce: readUserIds,
  toStorage: (value) => value,
  fromStorage: (raw, o) => (Array.isArray(raw) ? readUserIds(raw, o) : null),
  compare: (a, b) => compareNullable(a, b, compareIds),
  format: (value, _o, ctx) =>
    (value ?? [])
      .map((id) => ctx?.userName?.(id) ?? '')
      .filter((n) => n !== '')
      .join(', '),
  toPrimitive: (value) => value,
  apiType: (o) => (o.multiple ? 'multipleCollaborators' : 'singleCollaborator'),
  apiValue: (value, o, ctx) => (o.multiple ? value.map(ctx.user) : ctx.user(value[0] ?? '')),
});
