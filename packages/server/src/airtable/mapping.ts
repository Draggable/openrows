import {
  type AirtableReportField,
  BARCODE_TYPES,
  type ChoiceColor,
  type FieldTypeName,
  getFieldType,
  isValidTimeZone,
  MAX_CHOICE_NAME,
  MAX_CHOICES,
  nextChoiceColor,
  ROLLUP_FUNCTIONS,
  type RollupFunction,
} from '@openrows/shared';
import type { AirtableField, AirtableTable } from './client.js';

/**
 * Airtable's field types → ours. Pure: the job turns each Airtable table into a plan, then
 * creates what it says. A field we have is created with Airtable's options where they map
 * (precision, symbol, formats, choices and their colours, …). A field whose values Airtable
 * computes but ours would recompute differently (created time, autonumber, …) becomes a plain
 * field holding Airtable's values. Formulas are translated later, once every field they read
 * exists (`plan.formula`). Links are created once every table exists (`plan.link`), and
 * lookups, rollups and counts (`plan.computed`) like formulas, once what they read exists; one
 * that can't be made keeps Airtable's values in a plain field (`type`). Attachments are copied
 * by the job.
 */

/** The longest names and descriptions we keep. */
const MAX_NAME = 255;
const MAX_DESCRIPTION = 2000;

export interface PlannedField {
  airtableId: string;
  airtableType: string;
  name: string;
  isPrimary: boolean;
  /** What to create; a formula's fallback when it doesn't translate. */
  type: FieldTypeName;
  options: Record<string, unknown>;
  description?: string;
  /** Airtable's formula (fields as `{fldXXX}`): translated by the job, else kept as text. */
  formula?: string;
  /** A link: the Airtable table and inverse field it links to. */
  link?: { linkedTableId: string; inverseLinkFieldId: string | null; prefersSingle: boolean };
  /**
   * A lookup, rollup or count, by Airtable field ids; made once they are ours, else the
   * field is `type` with Airtable's values. A rollup without a known function is plain already.
   */
  computed?: {
    type: 'lookup' | 'rollup' | 'count';
    recordLinkFieldId: string;
    fieldIdInLinkedTable: string | null;
    function?: RollupFunction;
    separator?: string;
  };
  /** A report line when the field changes type on the way. */
  converted?: string;
}

export interface TablePlan {
  airtableId: string;
  name: string;
  description?: string;
  fields: PlannedField[];
  unsupported: AirtableReportField[];
}

/** Why a type isn't imported. */
const UNSUPPORTED: Record<string, string> = {
  externalSyncSource: "Airtable's sync source is Airtable's own: the synced values are kept.",
};

/** Airtable's colours (`blueLight2`, `greenBright`, …) by hue → our chip palette. */
const HUES: [string, ChoiceColor][] = [
  ['blue', 'blue'],
  ['cyan', 'teal'],
  ['teal', 'teal'],
  ['green', 'green'],
  ['yellow', 'olive'],
  ['orange', 'amber'],
  ['red', 'red'],
  ['pink', 'pink'],
  ['purple', 'violet'],
  ['gray', 'slate'],
];

export function mapColor(color: unknown, index: number): ChoiceColor {
  if (typeof color === 'string') {
    for (const [hue, ours] of HUES) if (color.startsWith(hue)) return ours;
  }
  return nextChoiceColor(index);
}

/** Currency symbols Airtable offers → ISO 4217 (others: USD, reported). */
const CURRENCIES: Record<string, string> = {
  $: 'USD',
  US$: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW',
  '₽': 'RUB',
  R$: 'BRL',
  CHF: 'CHF',
  kr: 'SEK',
  zł: 'PLN',
  A$: 'AUD',
  C$: 'CAD',
  CA$: 'CAD',
  AU$: 'AUD',
  NZ$: 'NZD',
  HK$: 'HKD',
  S$: 'SGD',
  R: 'ZAR',
  '₪': 'ILS',
  '₺': 'TRY',
  '฿': 'THB',
  '₫': 'VND',
  '₱': 'PHP',
  Rp: 'IDR',
  RM: 'MYR',
  Mex$: 'MXN',
};

const ICONS = new Set(['check', 'star', 'heart', 'thumbsUp', 'flag', 'dot']);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const rec = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function precision(o: Record<string, unknown>, fallback: number): number {
  const p = num(o['precision']);
  return p === undefined ? fallback : Math.min(8, Math.max(0, Math.round(p)));
}

function dateFormat(o: Record<string, unknown>): string {
  const name = str(rec(o['dateFormat'])['name']);
  return name && ['local', 'friendly', 'us', 'european', 'iso'].includes(name) ? name : 'local';
}

function dateTimeOptions(o: Record<string, unknown>) {
  const zone = str(o['timeZone']);
  return {
    dateFormat: dateFormat(o),
    timeFormat: str(rec(o['timeFormat'])['name']) === '24hour' ? '24h' : '12h',
    timeZone: zone && zone !== 'utc' && zone !== 'client' && isValidTimeZone(zone) ? zone : 'UTC',
  };
}

function choices(o: Record<string, unknown>) {
  const list = Array.isArray(o['choices']) ? o['choices'] : [];
  const seen = new Set<string>();
  const out: { id: string; name: string; color: ChoiceColor }[] = [];
  for (const raw of list) {
    const c = rec(raw);
    const name = str(c['name'])?.trim().slice(0, MAX_CHOICE_NAME);
    if (!name || seen.has(name.toLowerCase()) || out.length >= MAX_CHOICES) continue;
    seen.add(name.toLowerCase());
    const id = str(c['id']);
    out.push({
      id: id && /^[A-Za-z0-9]{1,64}$/.test(id) ? id : `sel${out.length}`,
      name,
      color: mapColor(c['color'], out.length),
    });
  }
  return { choices: out };
}

function durationFormat(o: Record<string, unknown>): string {
  const f = str(o['durationFormat'])?.toLowerCase();
  return f && ['h:mm', 'h:mm:ss', 'h:mm:ss.s', 'h:mm:ss.ss', 'h:mm:ss.sss'].includes(f)
    ? f
    : 'h:mm';
}

interface Mapped {
  type: FieldTypeName;
  options?: Record<string, unknown>;
  converted?: string;
}

/** One Airtable field's type and options; null when it isn't imported. */
export function mapFieldType(field: AirtableField): Mapped | null {
  const o = rec(field.options);
  switch (field.type) {
    case 'singleLineText':
    case 'email':
    case 'url':
      return { type: field.type };
    case 'phoneNumber':
      return { type: 'phone' };
    case 'multilineText':
      return { type: 'longText' };
    case 'richText':
      return { type: 'longText', options: { richText: true } };
    case 'number':
      return { type: 'number', options: { precision: precision(o, 0) } };
    case 'percent':
      return { type: 'percent', options: { precision: precision(o, 0) } };
    case 'currency': {
      const symbol = str(o['symbol'])?.trim() ?? '$';
      const code = CURRENCIES[symbol] ?? (/^[A-Z]{3}$/.test(symbol) ? symbol : undefined);
      return {
        type: 'currency',
        options: { precision: precision(o, 2), currencyCode: code ?? 'USD' },
        ...(code ? {} : { converted: `The currency symbol "${symbol}" became USD.` }),
      };
    }
    case 'duration':
      return { type: 'duration', options: { format: durationFormat(o) } };
    case 'rating': {
      const icon = str(o['icon']);
      return {
        type: 'rating',
        options: {
          max: Math.min(10, Math.max(1, num(o['max']) ?? 5)),
          icon: icon && ICONS.has(icon) ? icon : 'star',
          color: mapColor(o['color'], 1),
        },
      };
    }
    case 'checkbox': {
      const icon = str(o['icon']);
      return {
        type: 'checkbox',
        options: { icon: icon && ICONS.has(icon) ? icon : 'check', color: mapColor(o['color'], 0) },
      };
    }
    case 'date':
      return { type: 'date', options: { dateFormat: dateFormat(o) } };
    case 'dateTime':
      return { type: 'dateTime', options: dateTimeOptions(o) };
    case 'singleSelect':
      return { type: 'singleSelect', options: choices(o) };
    case 'multipleSelects':
      return { type: 'multipleSelect', options: choices(o) };
    case 'singleCollaborator':
      return { type: 'user', options: { multiple: false } };
    case 'multipleCollaborators':
      return { type: 'user', options: { multiple: true } };
    case 'barcode':
      return { type: 'barcode' };
    case 'multipleAttachments':
      return { type: 'attachment' };
    // Computed by Airtable; ours would compute other values (the import's time, our numbers),
    // so they keep Airtable's.
    case 'createdTime':
    case 'lastModifiedTime': {
      const result = rec(o['result']);
      const opts = dateTimeOptions(rec(result['options']));
      return rec(result)['type'] === 'date'
        ? {
            type: 'date',
            options: { dateFormat: opts.dateFormat },
            converted: 'Kept as a date with the values from Airtable.',
          }
        : {
            type: 'dateTime',
            options: opts,
            converted: 'Kept as a date and time with the values from Airtable.',
          };
    }
    case 'createdBy':
    case 'lastModifiedBy':
      return {
        type: 'user',
        options: { multiple: false },
        converted: 'Kept as a user field with the people from Airtable.',
      };
    case 'autoNumber':
      return {
        type: 'number',
        options: { precision: 0 },
        converted: 'Kept as a number with the values from Airtable.',
      };
    case 'button':
      return {
        type: 'url',
        converted: "Kept as a URL field with each button's link (the button's label is lost).",
      };
    case 'aiText':
      return { type: 'longText', converted: 'Kept as long text with the generated values.' };
    default:
      return null;
  }
}

/** The fallback of a formula that doesn't translate: text holding Airtable's results. */
const FORMULA_FALLBACK: FieldTypeName = 'singleLineText';

/** `{fldXXX}` in an Airtable formula → `{Field name}`, for people to read. */
export function readableFormula(formula: string, names: ReadonlyMap<string, string>): string {
  return formula.replace(/\{(fld[A-Za-z0-9]{14})\}/g, (whole, id: string) => {
    const name = names.get(id);
    return name === undefined ? whole : `{${name}}`;
  });
}

/** `{fldXXX}` → `{<our field id>}` (our stored form); null when one isn't ours. */
export function storedFormula(formula: string, ids: ReadonlyMap<string, string>): string | null {
  let missing = false;
  const out = formula.replace(/\{(fld[A-Za-z0-9]{14})\}/g, (_whole, id: string) => {
    const ours = ids.get(id);
    if (ours === undefined) missing = true;
    return `{${ours ?? id}}`;
  });
  return missing ? null : out;
}

function uniqueName(raw: string, taken: Set<string>, fallback: string): string {
  const base = raw.trim().slice(0, MAX_NAME) || fallback;
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, MAX_NAME - suffix.length)}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

/** The tables in Airtable's order, with unique names (as our names compare: case-insensitive). */
export function planTables(tables: readonly AirtableTable[]): TablePlan[] {
  const tableNames = new Set<string>();
  return tables.map((t) => {
    const names = new Set<string>();
    const unsupported: AirtableReportField[] = [];
    const tableName = uniqueName(t.name, tableNames, 'Table');
    const fields: PlannedField[] = [];
    // The primary field first: our tables are created with it.
    const ordered = [
      ...t.fields.filter((f) => f.id === t.primaryFieldId),
      ...t.fields.filter((f) => f.id !== t.primaryFieldId),
    ];
    for (const f of ordered) {
      const isPrimary = f.id === t.primaryFieldId;
      const report = { table: tableName, field: f.name, type: f.type };
      const description = f.description?.slice(0, MAX_DESCRIPTION);
      if (f.type === 'formula') {
        const formula = str(rec(f.options)['formula']) ?? '';
        fields.push({
          airtableId: f.id,
          airtableType: f.type,
          name: uniqueName(f.name, names, isPrimary ? 'Name' : 'Field'),
          isPrimary,
          type: FORMULA_FALLBACK,
          options: {},
          ...(description ? { description } : {}),
          formula,
        });
        continue;
      }
      const special = isPrimary ? null : planRelational(f);
      if (special) {
        fields.push({
          airtableId: f.id,
          airtableType: f.type,
          name: uniqueName(f.name, names, 'Field'),
          isPrimary,
          ...(description ? { description } : {}),
          ...special,
        });
        continue;
      }
      const mapped = mapFieldType(f);
      if (!mapped) {
        if (isPrimary) {
          // Every table has a primary field: an unsupported one becomes text.
          fields.push({
            airtableId: f.id,
            airtableType: f.type,
            name: uniqueName(f.name, names, 'Name'),
            isPrimary,
            type: 'singleLineText',
            options: {},
            ...(description ? { description } : {}),
            converted: 'The primary field was kept as text.',
          });
          continue;
        }
        unsupported.push({
          ...report,
          message: UNSUPPORTED[f.type] ?? `There is no "${f.type}" field type here yet.`,
        });
        continue;
      }
      const def = getFieldType(mapped.type);
      const parsed = def.optionsSchema.safeParse(mapped.options ?? {});
      const primaryOk = !isPrimary || (!def.computed && !def.readOnly && mapped.type !== 'link');
      fields.push({
        airtableId: f.id,
        airtableType: f.type,
        name: uniqueName(f.name, names, isPrimary ? 'Name' : 'Field'),
        isPrimary,
        type: primaryOk ? mapped.type : 'singleLineText',
        options: primaryOk && parsed.success ? (parsed.data as Record<string, unknown>) : {},
        ...(description ? { description } : {}),
        ...(mapped.converted ? { converted: mapped.converted } : {}),
      });
    }
    return {
      airtableId: t.id,
      name: tableName,
      ...(t.description ? { description: t.description.slice(0, MAX_DESCRIPTION) } : {}),
      fields,
      unsupported,
    };
  });
}

/** A computed field's fallback: its result's type where we have it, else text. */
function resultType(o: Record<string, unknown>): Mapped {
  const result = rec(o['result']);
  const type = str(result['type']);
  const mapped = type
    ? mapFieldType({ id: 'fld00000000000000', name: '', type, options: rec(result['options']) })
    : null;
  if (mapped && writable(mapped.type) && mapped.type !== 'attachment') {
    const def = getFieldType(mapped.type);
    const parsed = def.optionsSchema.safeParse(mapped.options ?? {});
    return {
      type: mapped.type,
      options: parsed.success ? (parsed.data as Record<string, unknown>) : {},
    };
  }
  return { type: 'singleLineText', options: {} };
}

/** `SUM(values)`, `ARRAYJOIN(values, "; ")`, … → our rollup function and separator. */
export function rollupFunction(
  formula: unknown
): { function: RollupFunction; separator?: string } | null {
  if (typeof formula !== 'string') return null;
  const m = /^\s*([A-Z]+)\(\s*values\s*(?:,\s*(["'])(.{0,100}?)\2\s*)?\)\s*$/.exec(formula);
  const name = m?.[1] as RollupFunction | undefined;
  if (!name || !(ROLLUP_FUNCTIONS as readonly string[]).includes(name)) return null;
  if (m?.[3] !== undefined && name !== 'ARRAYJOIN') return null;
  return m?.[3] !== undefined ? { function: name, separator: m[3] } : { function: name };
}

/** Links, lookups, rollups and counts: what the job makes once their tables exist. */
function planRelational(
  f: AirtableField
): Pick<PlannedField, 'type' | 'options' | 'link' | 'computed' | 'converted'> | null {
  const o = rec(f.options);
  const linkField = str(o['recordLinkFieldId']);
  const inLinked = str(o['fieldIdInLinkedTable']) ?? null;
  switch (f.type) {
    case 'multipleRecordLinks': {
      const linkedTableId = str(o['linkedTableId']);
      if (!linkedTableId) return null;
      return {
        type: 'link',
        options: {},
        link: {
          linkedTableId,
          inverseLinkFieldId: str(o['inverseLinkFieldId']) ?? null,
          prefersSingle: o['prefersSingleRecordLink'] === true,
        },
      };
    }
    case 'multipleLookupValues':
    case 'lookup':
      if (!linkField || !inLinked) return null;
      return {
        type: 'singleLineText',
        options: {},
        computed: { type: 'lookup', recordLinkFieldId: linkField, fieldIdInLinkedTable: inLinked },
      };
    case 'count':
      if (!linkField) return null;
      return {
        type: 'number',
        options: { precision: 0 },
        computed: { type: 'count', recordLinkFieldId: linkField, fieldIdInLinkedTable: null },
      };
    case 'rollup': {
      const fallback = resultType(o);
      const fn = rollupFunction(o['formula']);
      if (!linkField || !inLinked || !fn) {
        // Airtable's API doesn't say which function most rollups use: keep their values.
        return {
          type: fallback.type,
          options: fallback.options ?? {},
          converted: "Airtable doesn't share this rollup's function: kept with Airtable's values.",
        };
      }
      return {
        type: fallback.type,
        options: fallback.options ?? {},
        computed: {
          type: 'rollup',
          recordLinkFieldId: linkField,
          fieldIdInLinkedTable: inLinked,
          ...fn,
        },
      };
    }
    default:
      return null;
  }
}

/** Airtable's collaborator value: `{ id, email, name }`. */
function emailOf(v: unknown): string | null {
  const email = str(rec(v)['email']);
  return email ? email.trim().toLowerCase() : null;
}

/**
 * One Airtable cell (`cellFormat=json`) as input for our field: what our registry's `coerce`
 * then reads. `people` maps lower-cased emails to our user ids (workspace members only).
 */
export function cellInput(
  field: Pick<PlannedField, 'airtableType' | 'type'>,
  value: unknown,
  people: ReadonlyMap<string, string>
): unknown {
  switch (field.airtableType) {
    case 'singleCollaborator':
    case 'createdBy':
    case 'lastModifiedBy':
    case 'multipleCollaborators': {
      const list = Array.isArray(value) ? value : [value];
      return list.flatMap((v) => {
        const email = emailOf(v);
        const id = email ? people.get(email) : undefined;
        return id ? [id] : [];
      });
    }
    case 'button':
      return str(rec(value)['url']) ?? null;
    case 'aiText': {
      const v = rec(value);
      return str(v['value']) ?? (typeof value === 'string' ? value : null);
    }
    case 'barcode': {
      const v = rec(value);
      const text = str(v['text']);
      const type = str(v['type']);
      const known = (BARCODE_TYPES as readonly string[]).includes(type ?? '');
      return text ? { text, type: known ? type : '' } : null;
    }
    default:
      break;
  }
  // Formulas kept as text, and primary fields that became text: Airtable's value as text.
  if (field.type === 'singleLineText' || field.type === 'longText') return textOf(value);
  return value;
}

/** A computed value as text: lists joined with commas, objects by their name or text. */
export function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(textOf).filter((v): v is string => v !== null && v !== '');
    return parts.length ? parts.join(', ') : null;
  }
  const o = rec(value);
  return str(o['name']) ?? str(o['text']) ?? str(o['value']) ?? str(o['email']) ?? null;
}

/** Whether a mapped field's type is one users can write (not computed by us). */
export function writable(type: FieldTypeName): boolean {
  const def = getFieldType(type);
  return !def.readOnly && !def.computed;
}
