import { z } from 'zod';
import type { EditorHint, FieldCategory, FieldTypeDef, FilterOperator } from './types.js';
import { compareNullable, compareText, defineFieldType, first, readText } from './util.js';

export const TEXT_OPERATORS = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'isEmpty',
  'isNotEmpty',
] as const satisfies readonly FilterOperator[];

/** Airtable's cap on a text cell. */
export const MAX_TEXT_LENGTH = 100_000;

export const emptyOptions = z.object({}).strict();

interface TextLikeSpec<O> {
  name: string;
  label: string;
  category: FieldCategory;
  optionsSchema: z.ZodType<O>;
  editor: EditorHint;
  maxLength: number;
  conversionInput?: 'primitive' | 'display';
  /** Normalizes text (`null` when it isn't a valid value). Must be idempotent. */
  normalize(text: string, options: O): string | null;
}

/** A field stored as `text`: single line, long text, email, URL, phone. */
export function textLike<O>(spec: TextLikeSpec<O>): FieldTypeDef<O, string> {
  const coerce = (input: unknown, options: O): string | null => {
    const text = readText(spec.name === 'longText' ? input : first(input));
    if (text === null) return null;
    const value = spec.normalize(text.slice(0, spec.maxLength), options);
    return value === null || value === '' || value.length > spec.maxLength ? null : value;
  };
  return defineFieldType<O, string>({
    name: spec.name,
    label: spec.label,
    category: spec.category,
    optionsSchema: spec.optionsSchema,
    storage: { kind: 'column', sqlType: 'text' },
    filterOperators: TEXT_OPERATORS,
    sort: 'text',
    formulaType: 'text',
    editor: spec.editor,
    readOnly: false,
    computed: false,
    conversionInput: spec.conversionInput ?? 'primitive',
    emptyValue: null,
    valueSchema: (options) =>
      z
        .string()
        .min(1)
        .max(spec.maxLength)
        .refine((v) => spec.normalize(v, options) === v, `Not a valid ${spec.label} value`),
    coerce,
    toStorage: (value) => value,
    fromStorage: (raw, options) => (typeof raw === 'string' ? coerce(raw, options) : null),
    compare: (a, b) => compareNullable(a, b, compareText),
    format: (value) => value ?? '',
    toPrimitive: (value) => value,
  });
}
