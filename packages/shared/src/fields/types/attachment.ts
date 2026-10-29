import { z } from 'zod';
import { compareNullable, compareNumber, defineFieldType } from '../util.js';

/**
 * Metadata of one stored file. The bytes live in object storage under `id`; the server signs
 * URLs (and thumbnails) when it reads a record, so no URL is stored.
 */
export const attachmentValueSchema = z
  .object({
    id: z.string().min(1).max(64),
    filename: z.string().trim().min(1).max(255),
    size: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    type: z
      .string()
      .max(255)
      .regex(/^[\w.+-]+\/[\w.+-]+$/),
    width: z.int().min(1).max(1_000_000).optional(),
    height: z.int().min(1).max(1_000_000).optional(),
  })
  .strict();

export type AttachmentValue = z.infer<typeof attachmentValueSchema>;

/** Valid attachment objects of the input (in order, first of each id), else `null`. */
function readAttachments(input: unknown): AttachmentValue[] | null {
  const items = Array.isArray(input) ? input : [input];
  const out: AttachmentValue[] = [];
  for (const item of items) {
    const parsed = attachmentValueSchema.safeParse(item);
    if (parsed.success && !out.some((a) => a.id === parsed.data.id)) out.push(parsed.data);
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

/**
 * Files, metadata only (upload and storage come with the attachments issue). The column is
 * `jsonb`. Text can't become an attachment, so converting to it yields empty; converting from it
 * gives the filenames.
 */
export const attachment = defineFieldType({
  name: 'attachment',
  label: 'Attachment',
  category: 'basic',
  optionsSchema: z.object({}).strict(),
  storage: { kind: 'column', sqlType: 'jsonb' },
  filterOperators: ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'],
  sort: 'none',
  formulaType: 'array',
  editor: { kind: 'attachment', align: 'left', width: 160 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () =>
    z
      .array(attachmentValueSchema)
      .min(1)
      .refine((a) => new Set(a.map((x) => x.id)).size === a.length, 'Duplicate attachment'),
  coerce: readAttachments,
  toStorage: (value) => value,
  fromStorage: (raw) => readAttachments(parseJson(raw)),
  // Not sortable in the grid; by count, for a total order.
  compare: (a, b) => compareNullable(a, b, (x, y) => compareNumber(x.length, y.length)),
  format: (value) => (value ?? []).map((a) => a.filename).join(', '),
  toPrimitive: (value) => (value === null ? null : value.map((a) => a.filename)),
  apiType: () => 'multipleAttachments',
  apiValue: (value, _o, ctx) => value.map((a) => ({ ...a, url: ctx.fileUrl(a.id) })),
});
