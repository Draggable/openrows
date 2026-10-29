import { z } from 'zod';
import { TEXT_OPERATORS } from '../text-like.js';
import {
  compareNullable,
  compareText,
  defineFieldType,
  first,
  hasControlChars,
  readText,
} from '../util.js';

/** The symbologies a barcode cell can name (what scanners report). */
export const BARCODE_TYPES = [
  'ean13',
  'ean8',
  'upca',
  'upce',
  'code128',
  'code39',
  'itf',
  'qr',
  'dataMatrix',
] as const;

export type BarcodeType = (typeof BARCODE_TYPES)[number];

export type BarcodeValue = { text: string; type: BarcodeType };

/** Longest value of a 2D code (a QR code holds at most 4,296 alphanumerics). */
export const MAX_BARCODE_TEXT = 4296;

/** GS1 check digit (EAN, UPC, ITF-14): the last digit of `digits` is valid. */
function gs1CheckDigitValid(digits: string): boolean {
  let sum = 0;
  const body = digits.slice(0, -1);
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** UPC-E (8 digits, number system 0 or 1) expanded to UPC-A, for its check digit. */
function upceToUpca(t: string): string {
  const ns = t[0] ?? '0';
  const d = t.slice(1, 7);
  const check = t[7] ?? '';
  const [a, b, c, x, y, z] = d.split('');
  let body: string;
  if (z === '0' || z === '1' || z === '2') body = `${a}${b}${z}0000${c}${x}${y}`;
  else if (z === '3') body = `${a}${b}${c}00000${x}${y}`;
  else if (z === '4') body = `${a}${b}${c}${x}00000${y}`;
  else body = `${a}${b}${c}${x}${y}0000${z}`;
  return `${ns}${body}${check}`;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/** Whether `text` is a valid value of `type` (lengths, character sets, check digits). */
export function isValidBarcode(text: string, type: BarcodeType): boolean {
  if (text === '' || text.length > MAX_BARCODE_TEXT) return false;
  switch (type) {
    case 'ean13':
      return /^\d{13}$/.test(text) && gs1CheckDigitValid(text);
    case 'ean8':
      return /^\d{8}$/.test(text) && gs1CheckDigitValid(text);
    case 'upca':
      return /^\d{12}$/.test(text) && gs1CheckDigitValid(text);
    case 'upce':
      return /^[01]\d{7}$/.test(text) && gs1CheckDigitValid(upceToUpca(text));
    case 'itf':
      // Interleaved 2 of 5 encodes digit pairs.
      return /^\d+$/.test(text) && text.length % 2 === 0 && text.length <= 80;
    case 'code39':
      return /^[0-9A-Z \-.$/+%]+$/.test(text) && text.length <= 80;
    case 'code128':
      return PRINTABLE_ASCII.test(text) && text.length <= 80;
    case 'qr':
    case 'dataMatrix':
      return !hasControlChars(text);
  }
}

/**
 * The type of a bare text, as a scanner without a symbology would see it: a valid EAN-13,
 * UPC-A or EAN-8 by its digits, else Code 128 when it's short printable ASCII, else QR.
 */
export function guessBarcodeType(text: string): BarcodeType | null {
  const order: BarcodeType[] = ['ean13', 'upca', 'ean8', 'code128', 'qr'];
  return order.find((t) => isValidBarcode(text, t)) ?? null;
}

const isBarcodeType = (t: unknown): t is BarcodeType =>
  typeof t === 'string' && (BARCODE_TYPES as readonly string[]).includes(t);

/** A barcode from `{ text, type }` (checked against the type), or from text (type guessed). */
function readBarcode(input: unknown): BarcodeValue | null {
  const v = first(input);
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const raw = 'text' in v ? readText(v.text) : null;
    const text = raw?.trim() ?? '';
    const type = 'type' in v ? v.type : undefined;
    if (type === undefined || type === null || type === '') {
      const guessed = guessBarcodeType(text);
      return guessed ? { text, type: guessed } : null;
    }
    return isBarcodeType(type) && isValidBarcode(text, type) ? { text, type } : null;
  }
  const text = readText(v)?.trim() ?? '';
  const guessed = guessBarcodeType(text);
  return guessed ? { text, type: guessed } : null;
}

export const barcodeValueSchema = z
  .object({ text: z.string().min(1).max(MAX_BARCODE_TEXT), type: z.enum(BARCODE_TYPES) })
  .strict()
  .refine((v) => isValidBarcode(v.text, v.type), 'Not a valid barcode of this type');

/**
 * A barcode: the scanned text plus its symbology (`{ text, type }`, a `jsonb` object). Writes
 * are checked per type (EAN/UPC check digits, Code 39 characters, ...); bare text gets the type
 * a scanner would report. Text filters, search and sorting read `text`. Camera scanning comes
 * later (mobile).
 */
export const barcode = defineFieldType<Record<string, never>, BarcodeValue>({
  name: 'barcode',
  label: 'Barcode',
  category: 'basic',
  optionsSchema: z.object({}).strict(),
  storage: { kind: 'column', sqlType: 'jsonb', textKey: 'text' },
  filterOperators: TEXT_OPERATORS,
  sort: 'text',
  formulaType: 'text',
  editor: { kind: 'barcode', align: 'left', width: 180 },
  readOnly: false,
  computed: false,
  conversionInput: 'primitive',
  emptyValue: null,
  valueSchema: () => barcodeValueSchema,
  coerce: readBarcode,
  toStorage: (value) => value,
  fromStorage: (raw) => readBarcode(raw),
  compare: (a, b) =>
    compareNullable(
      a,
      b,
      (x, y) => compareText(x.text, y.text) || (x.type < y.type ? -1 : x.type > y.type ? 1 : 0)
    ),
  format: (value) => value?.text ?? '',
  toPrimitive: (value) => value?.text ?? null,
});
