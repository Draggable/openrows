import { describe, expect, it } from 'vitest';
import { MAX_CHOICE_NAME, MAX_CHOICES, nextChoiceColor } from './choices.js';
import {
  formatInstant,
  parseDate,
  parseDisplayInstant,
  parseInstant,
  zoneOffset,
} from './datetime.js';
import { conversionOptions, convertValue, FIELD_TYPE_DEFS as T } from './index.js';
import { parseNumberText } from './util.js';

const choices = [
  { id: 'selA', name: 'Todo', color: 'green' as const },
  { id: 'selB', name: 'In progress', color: 'amber' as const },
  { id: 'selC', name: 'Done', color: 'blue' as const },
];
const selectOpts = { choices };
const USER = '0190f5a2-7b3c-7d4e-8f00-0123456789ab';

describe('text types', () => {
  it('singleLineText flattens line breaks and treats blank as empty', () => {
    const o = T.singleLineText.optionsSchema.parse({});
    expect(T.singleLineText.coerce('a\r\nb\nc', o)).toBe('a b c');
    expect(T.singleLineText.coerce('', o)).toBeNull();
    expect(T.singleLineText.coerce(12.5, o)).toBe('12.5');
    expect(T.singleLineText.coerce(['x', 'y'], o)).toBe('x');
    expect(T.singleLineText.filterOperators).toContain('contains');
  });

  it('longText keeps newlines, normalizes CRLF and joins arrays', () => {
    const o = T.longText.optionsSchema.parse({});
    expect(T.longText.coerce('a\r\nb', o)).toBe('a\nb');
    expect(T.longText.coerce(['x', 'y'], o)).toBe('x, y');
    expect(o).toEqual({ richText: false });
  });

  it('email, url and phone validate and normalize', () => {
    expect(T.email.coerce('  kevin@example.com ', {})).toBe('kevin@example.com');
    expect(T.email.coerce('kevin@', {})).toBeNull();
    expect(T.url.coerce('openrows.io/docs', {})).toBe('https://openrows.io/docs');
    expect(T.url.coerce('http://x.test/a?b=1', {})).toBe('http://x.test/a?b=1');
    expect(T.url.coerce('javascript:alert(1)', {})).toBeNull();
    expect(T.url.coerce('data:text/html,hi', {})).toBeNull();
    expect(T.phone.coerce(' +1  (555) 010-9999 ext. 12 ', {})).toBe('+1 (555) 010-9999 ext. 12');
    expect(T.phone.coerce('call me', {})).toBeNull();
  });
});

describe('number types', () => {
  it('parses typed numbers strictly', () => {
    expect(parseNumberText('1,234.5')).toEqual({ value: 1234.5, percent: false });
    expect(parseNumberText('-$3')).toEqual({ value: -3, percent: false });
    expect(parseNumberText('12%')).toEqual({ value: 12, percent: true });
    expect(parseNumberText('2026-10-25')).toBeNull();
    expect(parseNumberText('12abc')).toBeNull();
    expect(parseNumberText('1,23')).toBeNull();
  });

  it('number rounds to precision and honours allowNegative', () => {
    const o = T.number.optionsSchema.parse({ precision: 2 });
    expect(T.number.coerce('3.14159', o)).toBe(3.14);
    expect(T.number.coerce(true, o)).toBe(1);
    expect(T.number.coerce('abc', o)).toBeNull();
    expect(T.number.coerce(Number.POSITIVE_INFINITY, o)).toBeNull();
    expect(T.number.coerce(-1, T.number.optionsSchema.parse({ allowNegative: false }))).toBeNull();
    expect(T.number.format(1234.5, o)).toBe('1,234.50');
    expect(T.number.toStorage(1.5, o)).toBe('1.5');
    expect(T.number.fromStorage('1.50', o)).toBe(1.5);
    expect(T.number.filterOperators).toEqual([
      '=',
      '!=',
      '<',
      '<=',
      '>',
      '>=',
      'isEmpty',
      'isNotEmpty',
    ]);
  });

  it('currency formats with its code', () => {
    const o = T.currency.optionsSchema.parse({ currencyCode: 'EUR' });
    expect(T.currency.coerce('€1,000.456', o)).toBe(1000.46);
    expect(T.currency.format(1000.46, o, { locale: 'en-US' })).toBe('€1,000.46');
  });

  it('percent stores fractions; typed text is in percent', () => {
    const o = T.percent.optionsSchema.parse({ precision: 1 });
    expect(T.percent.coerce('50', o)).toBe(0.5);
    expect(T.percent.coerce('12.5%', o)).toBe(0.125);
    expect(T.percent.coerce(0.25, o)).toBe(0.25);
    expect(T.percent.format(0.125, o)).toBe('12.5%');
  });

  it('duration reads clocks and numbers and formats per option', () => {
    const hm = T.duration.optionsSchema.parse({});
    const hms = T.duration.optionsSchema.parse({ format: 'h:mm:ss.s' });
    expect(T.duration.coerce('1:30', hm)).toBe(5400);
    expect(T.duration.coerce('90', hm)).toBe(5400);
    expect(T.duration.coerce('1:02:03.46', hms)).toBe(3723.5);
    expect(T.duration.coerce('1:75', hm)).toBeNull();
    expect(T.duration.format(5400, hm)).toBe('1:30');
    expect(T.duration.format(3723.5, hms)).toBe('1:02:03.5');
    expect(T.duration.format(-90, T.duration.optionsSchema.parse({ format: 'h:mm:ss' }))).toBe(
      '-0:01:30'
    );
  });

  it('rating is 1..max, never clamped', () => {
    const o = T.rating.optionsSchema.parse({ max: 5 });
    expect(T.rating.coerce('4', o)).toBe(4);
    expect(T.rating.coerce(3.6, o)).toBe(4);
    expect(T.rating.coerce(0, o)).toBeNull();
    expect(T.rating.coerce(6, o)).toBeNull();
    expect(T.rating.storage.sqlType).toBe('smallint');
  });

  it('autoNumber is a read-only identity column read from bigint strings', () => {
    expect(T.autoNumber.storage).toEqual({ kind: 'identity', sqlType: 'bigint' });
    expect(T.autoNumber.readOnly).toBe(true);
    expect(T.autoNumber.fromStorage('42', {})).toBe(42);
    expect(T.autoNumber.fromStorage('0', {})).toBeNull();
    expect(T.autoNumber.coerce(1.5, {})).toBeNull();
  });
});

describe('checkbox', () => {
  it('reads truthy words; empty and NULL are false', () => {
    const o = T.checkbox.optionsSchema.parse({});
    expect(T.checkbox.coerce('Yes', o)).toBe(true);
    expect(T.checkbox.coerce('✓', o)).toBe(true);
    expect(T.checkbox.coerce('no', o)).toBe(false);
    expect(T.checkbox.coerce(null, o)).toBe(false);
    expect(T.checkbox.fromStorage(null, o)).toBe(false);
    expect(T.checkbox.emptyValue).toBe(false);
    expect(T.checkbox.filterOperators).toEqual(['is']);
  });
});

describe('dates and times', () => {
  it('date reads ISO and slash dates (day first for european)', () => {
    const us = T.date.optionsSchema.parse({ dateFormat: 'us' });
    const eu = T.date.optionsSchema.parse({ dateFormat: 'european' });
    expect(T.date.coerce('2026-10-25', us)).toBe('2026-10-25');
    expect(T.date.coerce('10/5/2026', us)).toBe('2026-10-05');
    expect(T.date.coerce('10/5/2026', eu)).toBe('2026-05-10');
    expect(T.date.coerce('2026-02-29', us)).toBeNull();
    expect(T.date.coerce('2024-02-29', us)).toBe('2024-02-29');
    expect(T.date.fromStorage(new Date('2026-10-25T00:00:00Z'), us)).toBe('2026-10-25');
    expect(
      T.date.format('2026-10-25', T.date.optionsSchema.parse({ dateFormat: 'friendly' }))
    ).toBe('October 25, 2026');
    expect(T.date.filterOperators).toContain('isWithin');
  });

  it('dateTime reads wall-clock input in its time zone and stores UTC', () => {
    const berlin = T.dateTime.optionsSchema.parse({ timeZone: 'Europe/Berlin', timeFormat: '24h' });
    // CEST (+02:00) in summer, CET (+01:00) after the switch on 2026-10-25.
    expect(T.dateTime.coerce('2026-07-01 09:30', berlin)).toBe('2026-07-01T07:30:00.000Z');
    expect(T.dateTime.coerce('2026-12-01 09:30', berlin)).toBe('2026-12-01T08:30:00.000Z');
    expect(T.dateTime.coerce('2026-07-01T09:30:00Z', berlin)).toBe('2026-07-01T09:30:00.000Z');
    expect(T.dateTime.coerce('2026-07-01T09:30:00-05:00', berlin)).toBe('2026-07-01T14:30:00.000Z');
    expect(T.dateTime.format('2026-07-01T07:30:00.000Z', { ...berlin, dateFormat: 'iso' })).toBe(
      '2026-07-01 09:30'
    );
    expect(T.dateTime.optionsSchema.safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(false);
  });

  it('handles DST gaps and offsets', () => {
    // 02:30 on 2026-03-29 doesn't exist in Berlin; it resolves forward.
    expect(parseInstant('2026-03-29 02:30', 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z');
    // West of UTC too: 02:30 on 2026-03-08 in New York is 03:30 EDT.
    expect(parseInstant('2026-03-08 02:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    // Overlaps take the earlier instant: 01:30 EDT on 2026-11-01.
    expect(parseInstant('2026-11-01 01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(parseInstant('2026-10-25 02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z');
    expect(zoneOffset(Date.parse('2026-01-01T00:00:00Z'), 'Asia/Kolkata')).toBe(330);
    expect(formatInstant('2026-01-01T00:00:00.000Z', 'America/New_York', 'us', '12h')).toBe(
      '12/31/2025 7:00 PM'
    );
    expect(parseDate('2026-13-01', false)).toBeNull();
  });

  it('reads back what date and dateTime display, in every format (#77: CSV re-import)', () => {
    for (const dateFormat of ['local', 'friendly', 'us', 'european', 'iso'] as const) {
      const o = T.date.optionsSchema.parse({ dateFormat });
      for (const day of ['2026-01-31', '2024-02-29', '1999-12-01']) {
        expect(T.date.coerce(T.date.format(day, o), o)).toBe(day);
      }
      for (const timeFormat of ['12h', '24h'] as const) {
        for (const timeZone of ['UTC', 'America/New_York', 'Asia/Kolkata']) {
          const dt = T.dateTime.optionsSchema.parse({ dateFormat, timeFormat, timeZone });
          for (const at of ['2026-01-31T15:30:00.000Z', '2026-07-04T00:05:00.000Z']) {
            expect(T.dateTime.coerce(T.dateTime.format(at, dt), dt)).toBe(at);
          }
        }
      }
    }
    expect(parseDate('Sept 3, 2026', false)).toBe('2026-09-03');
    expect(parseDate('3 Sep. 2026', false)).toBe('2026-09-03');
    expect(parseDate('Feb 30, 2026', false)).toBeNull();
    expect(parseDate('Ju 3, 2026', false)).toBeNull();
    expect(parseDisplayInstant('Jan 31, 2026 13:30 PM', false, 'UTC')).toBeNull();
  });

  it('createdTime and lastModifiedTime read system columns and are read-only', () => {
    expect(T.createdTime.storage).toEqual({
      kind: 'system',
      column: 'created_at',
      sqlType: 'timestamptz',
    });
    expect(T.lastModifiedTime.storage).toEqual({
      kind: 'system',
      column: 'updated_at',
      sqlType: 'timestamptz',
    });
    expect(T.createdTime.readOnly && T.createdTime.computed).toBe(true);
    expect(
      T.createdTime.fromStorage(
        new Date('2026-10-25T09:30:00Z'),
        T.createdTime.optionsSchema.parse({})
      )
    ).toBe('2026-10-25T09:30:00.000Z');
  });
});

describe('select types', () => {
  it('singleSelect matches by id, then name, then case-insensitive name', () => {
    const o = T.singleSelect.optionsSchema.parse(selectOpts);
    expect(T.singleSelect.coerce('selB', o)).toBe('selB');
    expect(T.singleSelect.coerce('Done', o)).toBe('selC');
    expect(T.singleSelect.coerce(' todo ', o)).toBe('selA');
    expect(T.singleSelect.coerce('nope', o)).toBeNull();
    expect(T.singleSelect.format('selB', o)).toBe('In progress');
    expect(T.singleSelect.fromStorage('deleted', o)).toBeNull();
    // Sorted by choice order, not by name.
    expect(T.singleSelect.compare('selA', 'selC', o)).toBeLessThan(0);
    expect(T.singleSelect.compare('selC', 'selB', o)).toBeGreaterThan(0);
  });

  it('rejects duplicate choice ids and unknown colours', () => {
    const dup = { choices: [choices[0], { ...choices[1], id: 'selA' }] };
    expect(T.singleSelect.optionsSchema.safeParse(dup).success).toBe(false);
    expect(
      T.singleSelect.optionsSchema.safeParse({ choices: [{ id: 'x', name: 'X', color: '#fff' }] })
        .success
    ).toBe(false);
    expect(nextChoiceColor(0)).toBe('green');
    expect(nextChoiceColor(11)).toBe('amber');
  });

  it('multipleSelect splits text, keeps order, drops unknowns and duplicates', () => {
    const o = T.multipleSelect.optionsSchema.parse(selectOpts);
    expect(T.multipleSelect.coerce('Done, todo, nope, Done', o)).toEqual(['selC', 'selA']);
    expect(T.multipleSelect.coerce(['selB', 'Todo'], o)).toEqual(['selB', 'selA']);
    expect(T.multipleSelect.coerce('nope', o)).toBeNull();
    expect(T.multipleSelect.format(['selC', 'selA'], o)).toBe('Done, Todo');
    expect(T.multipleSelect.filterOperators).toEqual(
      expect.arrayContaining(['hasAnyOf', 'hasAllOf', 'hasNoneOf', 'isExactly'])
    );
  });
});

describe('select typecast (#70)', () => {
  it('lists the names coerce would not match, trimmed and deduplicated case-insensitively', () => {
    const o = T.singleSelect.optionsSchema.parse(selectOpts);
    expect(T.singleSelect.unknownChoices?.(' Blocked ', o)).toEqual(['Blocked']);
    expect(T.singleSelect.unknownChoices?.('todo', o)).toEqual([]);
    expect(T.singleSelect.unknownChoices?.('selB', o)).toEqual([]);
    expect(T.singleSelect.unknownChoices?.(['New', 'Other'], o)).toEqual(['New']);
    expect(T.singleSelect.unknownChoices?.('   ', o)).toEqual([]);
    const m = T.multipleSelect.optionsSchema.parse(selectOpts);
    expect(T.multipleSelect.unknownChoices?.('Done, new, NEW , x', m)).toEqual(['new', 'x']);
    expect(T.multipleSelect.unknownChoices?.(['a, b', 'Todo'], m)).toEqual(['a, b']);
    expect(T.singleLineText.unknownChoices).toBeUndefined();
  });

  it('appends choices with the next palette colours, and coerce then matches them', () => {
    const o = T.multipleSelect.optionsSchema.parse(selectOpts);
    const next = T.multipleSelect.withChoices?.(o, ['New', 'Other']) ?? o;
    expect(next.choices.slice(0, 3)).toEqual(choices);
    expect(next.choices.slice(3).map((c) => [c.name, c.color])).toEqual([
      ['New', nextChoiceColor(3)],
      ['Other', nextChoiceColor(4)],
    ]);
    expect(next.choices[3]?.id).toMatch(/^sel[0-9a-f]{12}$/);
    expect(T.multipleSelect.optionsSchema.safeParse(next).success).toBe(true);
    expect(T.multipleSelect.coerce('new, Todo', next)).toEqual([next.choices[3]?.id, 'selA']);
  });

  it('conversion into a select keeps every distinct value as a choice', () => {
    const from = { type: 'singleLineText' as const, options: {} };
    const to = { type: 'singleSelect' as const, options: { choices: [choices[0]] } };
    const values = ['Todo', 'b', 'B', null, 'c', 'x'.repeat(MAX_CHOICE_NAME + 1), 'b'];
    const opts = conversionOptions(values, from, to) as { choices: typeof choices };
    expect(opts.choices.map((c) => c.name)).toEqual(['Todo', 'b', 'c']);
    for (const v of ['Todo', 'b', 'B', 'c']) {
      expect(convertValue(v, from, { ...to, options: opts })).not.toBeNull();
    }
    const multi = conversionOptions(['a, b', 'b, c'], from, {
      type: 'multipleSelect',
      options: { choices: [] },
    }) as { choices: typeof choices };
    expect(multi.choices.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    // Capped at MAX_CHOICES, and same-type option changes add nothing.
    const many = Array.from({ length: MAX_CHOICES + 5 }, (_, i) => `v${i}`);
    expect(
      (conversionOptions(many, from, { ...to, options: { choices: [] } }) as typeof selectOpts)
        .choices
    ).toHaveLength(MAX_CHOICES);
    expect(conversionOptions(['zz'], to, to)).toBe(to.options);
    expect(conversionOptions(['zz'], from, { type: 'number', options: {} })).toEqual({});
  });
});

describe('attachment', () => {
  const file = { id: 'att1', filename: 'a.png', size: 10, type: 'image/png', width: 4, height: 3 };

  it('keeps valid metadata, drops junk and duplicate ids', () => {
    expect(T.attachment.coerce([file, { id: 'x' }, file], {})).toEqual([file]);
    expect(T.attachment.coerce('a.png', {})).toBeNull();
    expect(T.attachment.fromStorage(JSON.stringify([file]), {})).toEqual([file]);
    expect(T.attachment.fromStorage('{not json', {})).toBeNull();
    expect(T.attachment.format([file], {})).toBe('a.png');
    expect(T.attachment.sort).toBe('none');
  });
});

describe('createdBy and lastModifiedBy', () => {
  it('store user ids and display names from context', () => {
    expect(T.createdBy.storage).toEqual({ kind: 'system', column: 'created_by', sqlType: 'uuid' });
    expect(T.lastModifiedBy.storage).toEqual({
      kind: 'system',
      column: 'updated_by',
      sqlType: 'uuid',
    });
    expect(T.createdBy.coerce(USER.toUpperCase(), {})).toBe(USER);
    expect(T.createdBy.coerce({ id: USER, name: 'Kevin' }, {})).toBe(USER);
    expect(T.createdBy.coerce('kevin', {})).toBeNull();
    expect(T.createdBy.format(USER, {}, { userName: () => 'Kevin' })).toBe('Kevin');
    expect(T.createdBy.format(USER, {})).toBe('');
  });
});

describe('convertValue', () => {
  const sel = {
    type: 'singleSelect' as const,
    options: T.singleSelect.optionsSchema.parse(selectOpts),
  };
  const multi = {
    type: 'multipleSelect' as const,
    options: T.multipleSelect.optionsSchema.parse(selectOpts),
  };
  const text = { type: 'singleLineText' as const, options: {} };
  const num = { type: 'number' as const, options: T.number.optionsSchema.parse({ precision: 1 }) };
  const cur = { type: 'currency' as const, options: T.currency.optionsSchema.parse({}) };
  const date = { type: 'date' as const, options: T.date.optionsSchema.parse({}) };
  const dt = {
    type: 'dateTime' as const,
    options: T.dateTime.optionsSchema.parse({ timeZone: 'Pacific/Auckland' }),
  };
  const check = { type: 'checkbox' as const, options: T.checkbox.optionsSchema.parse({}) };

  it('converts to text through the display value', () => {
    expect(convertValue(1234.5, num, text)).toBe('1,234.5');
    expect(convertValue(1234.5, cur, text)).toBe('$1,234.50');
    expect(convertValue('selB', sel, text)).toBe('In progress');
    expect(convertValue(true, check, text)).toBe('checked');
    expect(convertValue(false, check, text)).toBeNull();
    expect(
      convertValue(USER, { type: 'createdBy', options: {} }, text, { userName: () => 'Kevin' })
    ).toBe('Kevin');
  });

  it('converts between compatible types and empties lossy ones', () => {
    expect(convertValue('12.34', text, num)).toBe(12.3);
    expect(convertValue('twelve', text, num)).toBeNull();
    expect(convertValue('Done', text, sel)).toBe('selC');
    expect(convertValue(['selA', 'selC'], multi, sel)).toBe('selA');
    expect(convertValue('selB', sel, multi)).toEqual(['selB']);
    expect(convertValue(0, num, check)).toBe(false);
    expect(convertValue(2, num, check)).toBe(true);
    expect(convertValue('2026-10-25', date, num)).toBeNull();
    expect(convertValue(5, num, date)).toBeNull();
  });

  it('keeps the local day when a datetime becomes a date', () => {
    // 2026-10-25T20:00Z is already the 26th in Auckland.
    expect(convertValue('2026-10-25T20:00:00.000Z', dt, date)).toBe('2026-10-26');
    expect(convertValue('2026-10-26', date, dt)).toBe('2026-10-25T11:00:00.000Z');
  });

  it('re-coerces under new options when only the options change', () => {
    const num0 = {
      type: 'number' as const,
      options: T.number.optionsSchema.parse({ precision: 0 }),
    };
    expect(convertValue(2.6, num, num0)).toBe(3);
    const fewer = { type: 'singleSelect' as const, options: { choices: choices.slice(0, 1) } };
    expect(convertValue('selC', sel, fewer)).toBeNull();
  });

  it('gives empty for computed targets', () => {
    expect(
      convertValue('2026-10-25', date, { type: 'createdTime', options: dt.options })
    ).toBeNull();
    expect(convertValue(5, num, { type: 'autoNumber', options: {} })).toBeNull();
  });
});

describe('user (#43)', () => {
  const OTHER = '0190f5a2-7b3c-7d4e-8f00-0123456789ac';
  const single = T.user.optionsSchema.parse({});
  const multiple = T.user.optionsSchema.parse({ multiple: true });

  it('defaults to one person, notifications off', () => {
    expect(single).toEqual({ multiple: false, notify: false });
  });

  it('reads ids, { id } objects and comma-separated ids, capped by `multiple`', () => {
    expect(T.user.coerce(USER, single)).toEqual([USER]);
    expect(T.user.coerce({ id: USER.toUpperCase() }, single)).toEqual([USER]);
    expect(T.user.coerce([USER, OTHER, USER], multiple)).toEqual([USER, OTHER]);
    expect(T.user.coerce(`${USER}, ${OTHER}`, multiple)).toEqual([USER, OTHER]);
    expect(T.user.coerce([USER, OTHER], single)).toEqual([USER]);
    expect(T.user.coerce('Ada Lovelace', multiple)).toBeNull();
    expect(T.user.coerce([], multiple)).toBeNull();
  });

  it('shows names from the directory and validates the cap', () => {
    const names = new Map([[USER, 'Ada']]);
    expect(T.user.format([USER, OTHER], multiple, { userName: (id) => names.get(id) })).toBe('Ada');
    expect(T.user.valueSchema(single).safeParse([USER, OTHER]).success).toBe(false);
    expect(T.user.valueSchema(multiple).safeParse([USER, OTHER]).success).toBe(true);
  });

  it('converts from createdBy and keeps the first person when `multiple` goes off', () => {
    expect(
      convertValue(USER, { type: 'createdBy', options: {} }, { type: 'user', options: single })
    ).toEqual([USER]);
    expect(
      convertValue(
        [USER, OTHER],
        { type: 'user', options: multiple },
        { type: 'user', options: single }
      )
    ).toEqual([USER]);
  });
});

describe('barcode (#43)', () => {
  const o = T.barcode.optionsSchema.parse({});

  it('validates each symbology', () => {
    expect(T.barcode.coerce({ text: '4006381333931', type: 'ean13' }, o)).toEqual({
      text: '4006381333931',
      type: 'ean13',
    });
    // Wrong check digit.
    expect(T.barcode.coerce({ text: '4006381333932', type: 'ean13' }, o)).toBeNull();
    expect(T.barcode.coerce({ text: '96385074', type: 'ean8' }, o)).not.toBeNull();
    expect(T.barcode.coerce({ text: '036000291452', type: 'upca' }, o)).not.toBeNull();
    expect(T.barcode.coerce({ text: '036000291453', type: 'upca' }, o)).toBeNull();
    expect(T.barcode.coerce({ text: '01234565', type: 'upce' }, o)).not.toBeNull();
    expect(T.barcode.coerce({ text: '12345', type: 'itf' }, o)).toBeNull();
    expect(T.barcode.coerce({ text: '1234', type: 'itf' }, o)).not.toBeNull();
    expect(T.barcode.coerce({ text: 'ABC-123', type: 'code39' }, o)).not.toBeNull();
    expect(T.barcode.coerce({ text: 'abc', type: 'code39' }, o)).toBeNull();
    expect(T.barcode.coerce({ text: 'héllo', type: 'code128' }, o)).toBeNull();
    expect(T.barcode.coerce({ text: 'héllo wörld', type: 'qr' }, o)).not.toBeNull();
    expect(T.barcode.coerce({ text: 'x', type: 'pdf417' }, o)).toBeNull();
  });

  it('guesses the type of bare text as a scanner would', () => {
    expect(T.barcode.coerce('4006381333931', o)).toEqual({ text: '4006381333931', type: 'ean13' });
    expect(T.barcode.coerce(' SKU-42 ', o)).toEqual({ text: 'SKU-42', type: 'code128' });
    expect(T.barcode.coerce('https://openrows.io/ünïcode', o)?.type).toBe('qr');
    expect(T.barcode.coerce({ text: '96385074' }, o)?.type).toBe('ean8');
    expect(T.barcode.coerce('', o)).toBeNull();
  });

  it('shows and converts its text', () => {
    const v = { text: 'SKU-42', type: 'code128' as const };
    expect(T.barcode.format(v, o)).toBe('SKU-42');
    expect(
      convertValue(v, { type: 'barcode', options: o }, { type: 'singleLineText', options: {} })
    ).toBe('SKU-42');
  });
});

describe('button (#43)', () => {
  const o = T.button.optionsSchema.parse({});

  it('defaults to an "Open" label and an empty URL formula', () => {
    expect(o.label).toBe('Open');
    expect(o.formula).toBe('');
    expect(T.button.optionsSchema.safeParse({ label: '' }).success).toBe(false);
  });

  it('only keeps http(s) URLs', () => {
    expect(T.button.coerce('https://openrows.io/x?a=1', o)).toBe('https://openrows.io/x?a=1');
    expect(T.button.coerce('openrows.io', o)).toBe('https://openrows.io');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.example',
      'ftp://example.com',
      12,
    ]) {
      expect(T.button.coerce(bad, o)).toBeNull();
      expect(T.button.fromStorage(bad, o)).toBeNull();
    }
  });
});

describe('rich text (#43)', () => {
  const rich = T.longText.optionsSchema.parse({ richText: true });
  const plain = T.longText.optionsSchema.parse({});

  it('sanitizes Markdown on coerce only when rich text is on', () => {
    expect(T.longText.coerce('**bold** <b>x</b>', rich)).toBe('**bold** x');
    expect(T.longText.coerce('**bold** <b>x</b>', plain)).toBe('**bold** <b>x</b>');
    expect(T.longText.coerce('<script>alert(1)</script>', rich)).toBe('alert(1)');
    expect(T.longText.valueSchema(rich).safeParse('<img src=x onerror=alert(1)>').success).toBe(
      false
    );
  });

  it('turning rich text on re-sanitizes existing text', () => {
    expect(
      convertValue(
        'a [x](javascript:alert(1))',
        { type: 'longText', options: plain },
        { type: 'longText', options: rich }
      )
    ).toBe('a x');
  });
});

describe('computed jsonb cells', () => {
  const throughJson = (v: unknown) => JSON.parse(JSON.stringify(v));

  it('rollup and formula read -0 as 0, so the jsonb round-trip keeps the value', () => {
    const r = T.rollup.optionsSchema.parse({});
    const rollup = T.rollup.coerce(-0, r);
    expect(Object.is(rollup, 0)).toBe(true);
    expect(T.rollup.fromStorage(throughJson(T.rollup.toStorage(rollup, r)), r)).toBe(rollup);

    const f = T.formula.optionsSchema.parse({});
    const formula = T.formula.coerce(-0, f);
    expect(Object.is(formula, 0)).toBe(true);
    expect(T.formula.fromStorage(throughJson(T.formula.toStorage(formula, f)), f)).toBe(formula);
  });

  it('count reads -0 as 0, as its numeric column gives it back', () => {
    const c = T.count.optionsSchema.parse({});
    const count = T.count.coerce(-0, c);
    expect(Object.is(count, 0)).toBe(true);
    expect(T.count.fromStorage(T.count.toStorage(count, c), c)).toBe(count);
  });
});
