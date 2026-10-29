import { readdirSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  convertValue,
  FIELD_TYPE_DEFS,
  FIELD_TYPE_NAMES,
  type FieldTypeName,
  getFieldType,
  isFieldTypeName,
  publicFieldOptions,
} from './index.js';
import { FILTER_OPERATORS, type StorageValue } from './types.js';

const CHOICES = [
  { id: 'selA', name: 'Todo', color: 'green' },
  { id: 'selB', name: 'In progress', color: 'amber' },
  { id: 'selC', name: 'Done', color: 'blue' },
  { id: 'selD', name: 'a, b', color: 'red' },
];

/**
 * Options each type is tested with: the defaults plus non-default configurations. A new type must
 * add an entry (the test below fails otherwise).
 */
const SAMPLE_OPTIONS: Record<FieldTypeName, unknown[]> = {
  singleLineText: [{}],
  longText: [{}, { richText: true }],
  number: [{}, { precision: 2 }, { precision: 8, allowNegative: false }],
  currency: [{}, { precision: 0, currencyCode: 'EUR' }],
  percent: [{}, { precision: 1, allowNegative: false }],
  checkbox: [{}, { icon: 'star', color: 'red' }],
  date: [{}, { dateFormat: 'european' }, { dateFormat: 'iso' }],
  dateTime: [
    {},
    { timeZone: 'Europe/Berlin', timeFormat: '24h' },
    { timeZone: 'America/Los_Angeles', dateFormat: 'us' },
    { timeZone: 'Asia/Kolkata', dateFormat: 'european' },
  ],
  duration: [{}, { format: 'h:mm:ss' }, { format: 'h:mm:ss.sss' }],
  rating: [{}, { max: 10, icon: 'heart' }],
  singleSelect: [{}, { choices: CHOICES }],
  multipleSelect: [{}, { choices: CHOICES }],
  email: [{}],
  url: [{}],
  phone: [{}],
  barcode: [{}],
  link: [
    {},
    { linkedTableId: '0190f5a2-7b3c-7d4e-8f00-0123456789ab', prefersSingleRecordLink: true },
  ],
  lookup: [{}, { recordLinkFieldId: '0190f5a2-7b3c-7d4e-8f00-0123456789ab' }],
  rollup: [{}, { function: 'ARRAYJOIN', separator: ' / ' }, { function: 'AVG', precision: 2 }],
  count: [{}],
  formula: [
    {},
    { resultType: 'number', precision: 2 },
    { resultType: 'date', timeZone: 'Europe/Paris' },
  ],
  ai: [
    {},
    { output: 'number', precision: 2 },
    { output: 'singleSelect', choices: CHOICES },
    { output: 'summary', prompt: 'Summarize {01900000-0000-7000-8000-0000000000aa}' },
  ],
  button: [
    {},
    { label: 'Open site', formula: '"https://openrows.io"', resultType: 'text' },
    { label: 'Run', action: 'runAutomation' },
  ],
  attachment: [{}],
  autoNumber: [{}],
  createdTime: [{}, { timeZone: 'Pacific/Auckland' }],
  lastModifiedTime: [{}],
  user: [{}, { multiple: true }, { multiple: true, notify: true }],
  createdBy: [{}],
  lastModifiedBy: [{}],
  syncSource: [{}],
};

interface Configured {
  type: FieldTypeName;
  options: unknown;
}

const CONFIGS: Configured[] = FIELD_TYPE_NAMES.flatMap((type) =>
  SAMPLE_OPTIONS[type].map((raw) => ({
    type,
    options: getFieldType(type).optionsSchema.parse(raw),
  }))
);

const isoDate = fc
  .date({
    min: new Date('0001-01-01T00:00:00Z'),
    max: new Date('9999-12-31T23:59:59Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

const attachmentArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  filename: fc.string({ minLength: 1, maxLength: 12 }),
  size: fc.nat(),
  type: fc.constantFrom('image/png', 'application/pdf', 'text/plain'),
});

/** Inputs that hit every type's parser: free-form junk plus realistic values for each type. */
const inputArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything(),
  fc.string(),
  fc.double(),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.date(),
  isoDate,
  isoDate.map((s) => s.slice(0, 10)),
  isoDate.map((s) => s.slice(0, 16).replace('T', ' ')),
  fc.double({ min: -1e6, max: 1e6, noNaN: true }).map(String),
  fc.constantFrom(
    '',
    ' ',
    '12',
    '-3.5',
    '1,234.56',
    '$1,000',
    '50%',
    '1:30',
    '0:00:01.5',
    '10/25/2026',
    '25.10.2026',
    '2026-02-30',
    '2026-10-25T09:30:00+02:00',
    'yes',
    'checked',
    'Todo',
    'done',
    'a, b',
    'Todo, Done, nope',
    'selB',
    'kevin@example.com',
    'not an email',
    'openrows.io/docs',
    'https://openrows.io',
    'javascript:alert(1)',
    '+1 (555) 010-9999 x12',
    'line\nbreak\r\nhere',
    '0190f5a2-7b3c-7d4e-8f00-0123456789ab',
    '0190F5A2-7B3C-7D4E-8F00-0123456789AB',
    '42'
  ),
  fc.array(fc.constantFrom('Todo', 'Done', 'selC', 'nope', 'a, b')),
  fc.array(attachmentArb, { maxLength: 3 }),
  attachmentArb,
  fc.record({ id: fc.uuid() }),
  fc.array(fc.record({ id: fc.uuid(), name: fc.string({ maxLength: 8 }) }), { maxLength: 4 })
);

const configArb = fc.constantFrom(...CONFIGS);

function isValid(type: FieldTypeName, options: unknown, value: unknown): boolean {
  const def = getFieldType(type);
  if (value === def.emptyValue) return true;
  return def.valueSchema(options).safeParse(value).success;
}

/** What a driver hands back: JSON for `jsonb`, otherwise the value as sent. */
function throughDriver(storage: StorageValue, sqlType: string): unknown {
  return sqlType === 'jsonb' && storage !== null ? JSON.parse(JSON.stringify(storage)) : storage;
}

const RUNS = { numRuns: 400 };

describe('field-type registry', () => {
  it('registers every module in types/', () => {
    const files = readdirSync(new URL('./types/', import.meta.url))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, '').replace(/-(\w)/g, (_, c: string) => c.toUpperCase()));
    expect(new Set(files)).toEqual(new Set(FIELD_TYPE_NAMES));
  });

  it('has the 21 core types of issue #17, link (#34) and lookup, rollup, count (#35), formula (#37), user, barcode, button (#43), ai (#149) and syncSource (#154)', () => {
    expect([...FIELD_TYPE_NAMES].sort()).toEqual(
      [
        'ai',
        'singleLineText',
        'longText',
        'number',
        'currency',
        'percent',
        'checkbox',
        'date',
        'dateTime',
        'duration',
        'rating',
        'singleSelect',
        'multipleSelect',
        'email',
        'url',
        'phone',
        'attachment',
        'autoNumber',
        'createdTime',
        'lastModifiedTime',
        'createdBy',
        'lastModifiedBy',
        'link',
        'lookup',
        'rollup',
        'count',
        'formula',
        'user',
        'barcode',
        'button',
        'syncSource',
      ].sort()
    );
  });

  it('isFieldTypeName and getFieldType agree with the registry', () => {
    expect(isFieldTypeName('number')).toBe(true);
    expect(isFieldTypeName('toString')).toBe(false);
    expect(isFieldTypeName(3)).toBe(false);
    for (const name of FIELD_TYPE_NAMES) expect(getFieldType(name).name).toBe(name);
  });

  it.each(FIELD_TYPE_NAMES)('%s has consistent metadata', (name) => {
    const def = FIELD_TYPE_DEFS[name] as ReturnType<typeof getFieldType>;
    expect(def.label).not.toBe('');
    expect(def.filterOperators.length).toBeGreaterThan(0);
    for (const op of def.filterOperators) expect(FILTER_OPERATORS).toContain(op);
    expect(new Set(def.filterOperators).size).toBe(def.filterOperators.length);
    // Defaults alone are a valid configuration.
    expect(() => def.optionsSchema.parse({})).not.toThrow();
    // Unknown option keys are rejected, so typos don't pass silently.
    expect(def.optionsSchema.safeParse({ nope: 1 }).success).toBe(false);
    if (def.computed) {
      expect(def.readOnly).toBe(true);
      // Buttons render as a button, every other computed cell as text.
      expect(def.editor.kind).toBe(name === 'button' ? 'button' : 'none');
      expect(def.storage.kind).not.toBe('column');
    } else {
      expect(['column', 'link']).toContain(def.storage.kind);
      expect(def.editor.kind).not.toBe('none');
    }
    expect(def.editor.width).toBeGreaterThan(0);
    expect(SAMPLE_OPTIONS[name].length).toBeGreaterThan(0);
  });

  it('shows share links (#97) no ids of other objects and no formula in the public options', () => {
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const id = '01900000-0000-7000-8000-0000000000aa';
    const named: Record<string, unknown> = {
      link: { linkedTableId: id, inverseLinkFieldId: id, viewIdForRecordSelection: id },
      lookup: { recordLinkFieldId: id, fieldIdInLinkedTable: id },
      rollup: { recordLinkFieldId: id, fieldIdInLinkedTable: id, precision: 2 },
      count: { recordLinkFieldId: id },
      formula: { formula: `{${id}} * 2`, referencedFieldIds: [id], resultType: 'number' },
      button: { formula: `{${id}}`, referencedFieldIds: [id], label: 'Go' },
      ai: { prompt: `Summarize {${id}}`, referencedFieldIds: [id] },
    };
    for (const { type, options } of CONFIGS) {
      const shown = JSON.stringify(
        publicFieldOptions(type, { ...(options as object), ...(named[type] as object) })
      );
      // Choice ids identify the cell's own choices; nothing else may name an object.
      const withoutChoices = shown.replace(/"choices":\[[^\]]*\]/g, '');
      expect(withoutChoices, type).not.toMatch(uuid);
      expect(shown, type).not.toContain('"formula"');
      expect(shown, type).not.toContain('"prompt"');
    }
    expect(publicFieldOptions('rollup', named['rollup'])).toEqual({
      function: 'SUM',
      separator: ', ',
      precision: 2,
    });
    expect(publicFieldOptions('number', { precision: 2 })).toMatchObject({ precision: 2 });
  });

  it('maps types to the ADR-001 column types', () => {
    const sql = Object.fromEntries(
      FIELD_TYPE_NAMES.map((n) => [n, getFieldType(n).storage.sqlType])
    );
    expect(sql).toEqual({
      singleLineText: 'text',
      longText: 'text',
      number: 'numeric',
      currency: 'numeric',
      percent: 'numeric',
      checkbox: 'boolean',
      date: 'date',
      dateTime: 'timestamptz',
      duration: 'numeric',
      rating: 'smallint',
      singleSelect: 'text',
      multipleSelect: 'text[]',
      email: 'text',
      url: 'text',
      phone: 'text',
      barcode: 'jsonb',
      button: 'jsonb',
      user: 'text[]',
      attachment: 'jsonb',
      link: 'jsonb',
      lookup: 'text[]',
      rollup: 'jsonb',
      count: 'numeric',
      formula: 'jsonb',
      ai: 'jsonb',
      autoNumber: 'bigint',
      createdTime: 'timestamptz',
      lastModifiedTime: 'timestamptz',
      createdBy: 'uuid',
      lastModifiedBy: 'uuid',
      syncSource: 'text',
    });
  });
});

describe('field-type properties (fast-check)', () => {
  it('coerce never throws and yields a valid value or empty', () => {
    fc.assert(
      fc.property(configArb, inputArb, ({ type, options }, input) => {
        const value = getFieldType(type).coerce(input, options);
        expect(isValid(type, options, value)).toBe(true);
      }),
      RUNS
    );
  });

  it('coerce is idempotent', () => {
    fc.assert(
      fc.property(configArb, inputArb, ({ type, options }, input) => {
        const def = getFieldType(type);
        const once = def.coerce(input, options);
        expect(def.coerce(once, options)).toEqual(once);
      }),
      RUNS
    );
  });

  it('toStorage/fromStorage round-trips', () => {
    fc.assert(
      fc.property(configArb, inputArb, ({ type, options }, input) => {
        const def = getFieldType(type);
        const value = def.coerce(input, options);
        const stored = throughDriver(def.toStorage(value, options), def.storage.sqlType);
        expect(def.fromStorage(stored, options)).toEqual(value);
      }),
      RUNS
    );
  });

  it('fromStorage never throws on junk', () => {
    fc.assert(
      fc.property(configArb, inputArb, ({ type, options }, raw) => {
        const def = getFieldType(type);
        expect(() => def.fromStorage(raw, options)).not.toThrow();
      }),
      RUNS
    );
  });

  it('compare is a consistent order with empty first', () => {
    fc.assert(
      fc.property(configArb, inputArb, inputArb, ({ type, options }, x, y) => {
        const def = getFieldType(type);
        const a = def.coerce(x, options);
        const b = def.coerce(y, options);
        expect(def.compare(a, a, options)).toBe(0);
        expect(Math.sign(def.compare(a, b, options))).toBe(
          -Math.sign(def.compare(b, a, options)) || 0
        );
        if (a !== null && type !== 'checkbox')
          expect(def.compare(null, a, options)).toBeLessThan(0);
      }),
      RUNS
    );
  });

  it('format and toPrimitive never throw', () => {
    fc.assert(
      fc.property(configArb, inputArb, ({ type, options }, input) => {
        const def = getFieldType(type);
        const value = def.coerce(input, options);
        expect(typeof def.format(value, options, { userName: () => 'Kevin' })).toBe('string');
        if (value === def.emptyValue && type !== 'checkbox')
          expect(def.format(value, options)).toBe('');
        def.toPrimitive(value, options);
      }),
      RUNS
    );
  });

  it('conversion between any two types is total and yields valid values or empty', () => {
    fc.assert(
      fc.property(configArb, configArb, inputArb, (from, to, input) => {
        const value = getFieldType(from.type).coerce(input, from.options);
        const converted = convertValue(value, from, to);
        expect(isValid(to.type, to.options, converted)).toBe(true);
        // Converting to the same configuration keeps the value.
        if (from === to) expect(converted).toEqual(getFieldType(to.type).readOnly ? null : value);
      }),
      { numRuns: 2000 }
    );
  });

  it('every pair of types converts without throwing, including empty values', () => {
    for (const from of CONFIGS) {
      for (const to of CONFIGS) {
        const empty = getFieldType(from.type).emptyValue;
        expect(isValid(to.type, to.options, convertValue(empty, from, to))).toBe(true);
      }
    }
  });
});
