import { z } from 'zod';
import { compareNullable, compareText, defineFieldType } from '../util.js';

/** Most records one link cell may name on a write (reads of an inverse side aren't capped). */
export const MAX_LINKS_PER_CELL = 1000;

/** Longest display name a link value carries (the linked record's primary field, as text). */
const MAX_LINK_NAME = 10_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isRecordId = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

/**
 * One linked record: its id, and on reads the display text of its primary field (`name`, set by
 * the server; ignored on writes).
 */
export const linkItemSchema = z
  .object({
    id: z.string().regex(UUID_RE),
    name: z.string().max(MAX_LINK_NAME).optional(),
  })
  .strict();

export type LinkItem = z.infer<typeof linkItemSchema>;
export type LinkValue = LinkItem[];

/**
 * Link options (Airtable names). `linkedTableId` is the table of the same base the field links
 * to (required on create; a link to its own table is a self-link, with no inverse field).
 * `inverseLinkFieldId` is the field the server creates in the linked table, kept in sync with
 * this one (set by the server, never from input). `prefersSingleRecordLink` turns off "allow
 * linking to multiple records". `viewIdForRecordSelection` limits linkable records to those a
 * view of the linked table shows (enforced on writes too).
 */
export const linkOptionsSchema = z
  .object({
    linkedTableId: z.uuid().nullable().default(null),
    inverseLinkFieldId: z.uuid().nullable().default(null),
    prefersSingleRecordLink: z.boolean().default(false),
    viewIdForRecordSelection: z.uuid().nullable().default(null),
  })
  .strict();

export type LinkOptions = z.infer<typeof linkOptionsSchema>;

function readItem(input: unknown): LinkItem | null {
  if (isRecordId(input)) return { id: input.toLowerCase() };
  if (typeof input !== 'object' || input === null || !('id' in input)) return null;
  const { id, name } = input as { id: unknown; name?: unknown };
  if (!isRecordId(id)) return null;
  return typeof name === 'string' && name.length <= MAX_LINK_NAME
    ? { id: id.toLowerCase(), name }
    : { id: id.toLowerCase() };
}

/** Linked record ids from ids, `{ id }` objects or arrays of them (first `max`, once each). */
function readLinks(input: unknown, max: number): LinkValue | null {
  const items = Array.isArray(input) ? input : [input];
  const out: LinkItem[] = [];
  for (const raw of items) {
    const item = readItem(raw);
    if (item && !out.some((x) => x.id === item.id)) out.push(item);
    if (out.length >= max) break;
  }
  return out.length ? out : null;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A linked record's display text: its primary value, or Airtable's "Unnamed record". */
export const linkName = (item: LinkItem): string => item.name || 'Unnamed record';

/**
 * Links to records of another table of the same base (ADR-001: a junction table per link field,
 * `l_<field id hex>`, shared with the inverse field, so the field has no column of its own).
 * The value is the linked records in order, `{ id, name }`. `coerce` reads record ids only:
 * matching primary-field text (paste, import, conversion, typecast) needs the linked table, so
 * the server's RecordService does it before coercing.
 */
export const link = defineFieldType({
  name: 'link',
  label: 'Link to another record',
  category: 'people',
  optionsSchema: linkOptionsSchema,
  // The linked table, its inverse field and the picker's view stay private.
  publicOptions: (o) => ({ prefersSingleRecordLink: o.prefersSingleRecordLink }),
  storage: { kind: 'link', sqlType: 'jsonb' },
  // `contains` matches the linked records' names; `hasAnyOf`/`hasNoneOf` take record ids.
  filterOperators: ['contains', 'doesNotContain', 'hasAnyOf', 'hasNoneOf', 'isEmpty', 'isNotEmpty'],
  sort: 'text',
  formulaType: 'array',
  editor: { kind: 'link', align: 'left', width: 200 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: (o) =>
    z
      .array(linkItemSchema)
      .min(1)
      .max(o.prefersSingleRecordLink ? 1 : MAX_LINKS_PER_CELL)
      .refine((a) => new Set(a.map((x) => x.id)).size === a.length, 'Duplicate record'),
  coerce: (input, o) => readLinks(input, o.prefersSingleRecordLink ? 1 : MAX_LINKS_PER_CELL),
  toStorage: (value) => value,
  // Reads aren't capped: an inverse side can link many records.
  fromStorage: (raw) => readLinks(parseJson(raw), Number.POSITIVE_INFINITY),
  compare: (a, b) =>
    compareNullable(a, b, (x, y) =>
      compareText(x.map(linkName).join(', '), y.map(linkName).join(', '))
    ),
  format: (value) => (value ?? []).map(linkName).join(', '),
  toPrimitive: (value) => (value === null ? null : value.map(linkName)),
  // Airtable's links are record ids.
  apiType: () => 'multipleRecordLinks',
  apiValue: (value) => value.map((x) => x.id),
});
