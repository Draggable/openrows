import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FIXTURE_FIELDS } from './fixtures.js';
import {
  type EvaluateOptions,
  evaluateFormula,
  FORMULA_ERROR,
  FORMULA_FUNCTIONS,
  FormulaDate,
  type FormulaValue,
  FUNCTION_IMPLS,
  fieldFormulaValue,
  formulaResult,
  LAZY_FUNCTIONS,
  parseFormula,
} from './index.js';

const fields = FIXTURE_FIELDS;
const idOf = (name: string) => fields.find((f) => f.name === name)?.id ?? name;

const NOW = Date.parse('2026-10-26T15:30:45.123Z');

type Record_ = Record<string, FormulaValue>;

function run(source: string, record: Record_ = {}, extra: Partial<EvaluateOptions> = {}) {
  const parsed = parseFormula(source, { fields });
  if (!parsed.ok) throw new Error(`${source}: ${parsed.error.message}`);
  const values = new Map(Object.entries(record).map(([name, v]) => [idOf(name), v]));
  return evaluateFormula(parsed.ast, {
    field: (id) => values.get(id) ?? null,
    now: NOW,
    recordId: 'rec0190f5a27b3c',
    createdTime: Date.parse('2026-01-02T03:04:05.000Z'),
    lastModifiedTime: Date.parse('2026-10-01T00:00:00.000Z'),
    ...extra,
  });
}

/** The stored cell value (numbers, text, `#ERROR!`, `null` for blank). */
const cell = (source: string, record?: Record_) => formulaResult(run(source, record));

function expectCells(cases: readonly [string, unknown][], record?: Record_) {
  for (const [source, expected] of cases) {
    expect([source, cell(source, record)]).toEqual([source, expected]);
  }
}

describe('the function catalog', () => {
  it('implements every function the type checker knows, and nothing else', () => {
    const implemented = new Set([...Object.keys(FUNCTION_IMPLS), ...LAZY_FUNCTIONS]);
    expect([...implemented].sort()).toEqual(Object.keys(FORMULA_FUNCTIONS).sort());
  });
});

describe('operators', () => {
  it('does arithmetic with blanks as 0 and booleans as 1/0', () => {
    expectCells(
      [
        ['1 + 2 * 3', 7],
        ['(1 + 2) * 3', 9],
        ['10 / 4', 2.5],
        ['-{Price}', 0],
        ['{Price} + 1', 1],
        ['{Done} + 1', 2],
        ['2 - 5', -3],
        ['0.1 + 0.2', 0.30000000000000004],
      ],
      { Done: true }
    );
  });

  it('errors on division by zero and on non-numeric text', () => {
    expectCells([
      ['1 / 0', FORMULA_ERROR],
      ['{Price} / {Qty}', FORMULA_ERROR],
      ['VALUE("abc") + 1', FORMULA_ERROR],
    ]);
  });

  it('joins text with &', () => {
    expectCells(
      [
        ['{Name} & " x" & {Qty}', 'Widget x3'],
        ['"a" & BLANK() & "b"', 'ab'],
        ['TRUE() & ""', '1'],
        ['{Tags} & ""', 'a, b'],
      ],
      { Name: 'Widget', Qty: 3, Tags: ['a', 'b'] }
    );
  });

  it('compares numbers, text, dates and blanks', () => {
    expectCells(
      [
        ['{Price} > 10', 1],
        ['{Price} = 12.5', 1],
        ['{Price} != 12.5', 0],
        ['"abc" = "abc"', 1],
        ['"abc" = "ABC"', 0],
        ['"a" < "b"', 1],
        ['BLANK() = ""', 1],
        ['BLANK() = 0', 1],
        ['{Due} < "2026-12-01"', 1],
        ['{Due} = "2026-11-15"', 1],
        ['{Due} >= {Start}', 1],
      ],
      {
        Price: 12.5,
        Due: new FormulaDate(Date.parse('2026-11-15T00:00:00Z'), true),
        Start: new FormulaDate(Date.parse('2026-11-14T08:00:00Z')),
      }
    );
  });
});

describe('text functions', () => {
  it('CONCATENATE, LEFT, RIGHT, MID, LEN, UPPER, LOWER, TRIM, REPT, T', () => {
    expectCells([
      ['CONCATENATE("Bob", " - ", 43)', 'Bob - 43'],
      ['CONCATENATE()', null],
      ['LEFT("quick brown fox", 5)', 'quick'],
      ['LEFT("ab", 10)', 'ab'],
      ['LEFT("ab", -1)', FORMULA_ERROR],
      ['RIGHT("quick brown fox", 5)', 'n fox'],
      ['RIGHT("abc", 0)', null],
      ['MID("quick brown fox", 6, 5)', ' brow'],
      ['MID("abc", 0, 1)', FORMULA_ERROR],
      ['LEN("quick brown fox")', 15],
      ['LEN("😀a")', 2],
      ['LEN(BLANK())', 0],
      ['UPPER("Hello")', 'HELLO'],
      ['LOWER("Hello")', 'hello'],
      ['TRIM("   Hello!  ")', 'Hello!'],
      ['REPT("Hi! ", 3)', 'Hi! Hi! Hi! '],
      ['REPT("x", 200000)', FORMULA_ERROR],
      ['T("text")', 'text'],
      ['T(42)', null],
    ]);
  });

  it('FIND and SEARCH (1-based; FIND gives 0 and SEARCH blank when missing)', () => {
    expectCells([
      ['FIND("fox", "quick brown fox")', 13],
      ['FIND("Fox", "quick brown fox")', 0],
      ['FIND("o", "hello world", 6)', 8],
      ['FIND("", "abc")', 1],
      ['SEARCH("Fox", "quick brown fox")', 13],
      ['SEARCH("cat", "quick brown fox")', null],
    ]);
  });

  it('SUBSTITUTE and REPLACE', () => {
    expectCells([
      ['SUBSTITUTE("gold mold", "old", "et")', 'get met'],
      ['SUBSTITUTE("gold mold", "old", "et", 2)', 'gold met'],
      ['SUBSTITUTE("gold mold", "old", "et", 3)', 'gold mold'],
      ['SUBSTITUTE("abc", "", "x")', 'abc'],
      ['REPLACE("database", 2, 5, "o")', 'dose'],
      ['REPLACE("abc", 10, 1, "!")', 'abc!'],
    ]);
  });

  it('ENCODE_URL_COMPONENT', () => {
    expectCells([['ENCODE_URL_COMPONENT("chicken & waffles")', 'chicken%20%26%20waffles']]);
  });

  it('REGEX_MATCH, REGEX_EXTRACT and REGEX_REPLACE on RE2', () => {
    expectCells([
      ['REGEX_MATCH("Hello World", "Hello.World")', 1],
      ['REGEX_MATCH("Hello World", "^World")', 0],
      ['REGEX_MATCH("ABC", "(?i)abc")', 1],
      ['REGEX_EXTRACT("Hello World", "W.*")', 'World'],
      ['REGEX_EXTRACT("abc", "\\\\d+")', null],
      ['REGEX_EXTRACT("Order 1234 shipped", "[0-9]+")', '1234'],
      ['REGEX_REPLACE("Hello World", " W.*", "")', 'Hello'],
      ['REGEX_REPLACE("a1b22c333", "[0-9]+", "#")', 'a#b#c#'],
      ['REGEX_REPLACE("john smith", "(\\\\w+) (\\\\w+)", "$2, $1")', 'smith, john'],
      // Invalid or non-RE2 patterns (backreferences, lookaround) are errors, not crashes.
      ['REGEX_MATCH("aa", "(a)\\\\1")', FORMULA_ERROR],
      ['REGEX_MATCH("ab", "a(?=b)")', FORMULA_ERROR],
      ['REGEX_MATCH("a", "(")', FORMULA_ERROR],
    ]);
  });

  it('runs a catastrophic-backtracking pattern in linear time', () => {
    const started = Date.now();
    const result = run('REGEX_MATCH({Name}, "^(a+)+$")', { Name: `${'a'.repeat(30_000)}b` });
    expect(result).toEqual({ ok: true, value: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('numeric functions', () => {
  it('ABS, INT, MOD, POWER, SQRT, LOG, EXP, EVEN, ODD', () => {
    expectCells([
      ['ABS(-5.5)', 5.5],
      ['INT(1.99)', 1],
      ['INT(-1.5)', -2],
      ['MOD(7, 5)', 2],
      ['MOD(-3, 2)', 1],
      ['MOD(1, 0)', FORMULA_ERROR],
      ['POWER(2, 10)', 1024],
      ['POWER(10, 400)', FORMULA_ERROR],
      ['SQRT(16)', 4],
      ['SQRT(-1)', FORMULA_ERROR],
      ['LOG(1000)', 3],
      ['LOG(8, 2)', 3],
      ['LOG(0)', FORMULA_ERROR],
      ['EXP(0)', 1],
      ['EVEN(1.5)', 2],
      ['EVEN(-1)', -2],
      ['ODD(2)', 3],
      ['ODD(0)', 1],
    ]);
  });

  it('ROUND, ROUNDUP, ROUNDDOWN, CEILING, FLOOR', () => {
    expectCells([
      ['ROUND(1.99, 0)', 2],
      ['ROUND(2.5)', 3],
      ['ROUND(-2.5)', -3],
      ['ROUND(1.005, 2)', 1.01],
      ['ROUND(1234.5678, -2)', 1200],
      ['ROUNDUP(1.11, 1)', 1.2],
      ['ROUNDUP(-1.11, 1)', -1.2],
      ['ROUNDDOWN(1.99, 1)', 1.9],
      ['ROUNDDOWN(-1.99, 0)', -1],
      ['CEILING(1.01)', 2],
      ['CEILING(7, 5)', 10],
      ['CEILING(0.123, 0.01)', 0.13],
      ['FLOOR(1.99)', 1],
      ['FLOOR(7, 5)', 5],
      ['FLOOR(-1.5)', -2],
    ]);
  });

  it('SUM, AVERAGE, MAX, MIN and the COUNTs flatten lists and skip text and blanks', () => {
    const record = { 'Lookup Prices': [1, 2, null, 'x', 3] };
    expectCells(
      [
        ['SUM(1, 2, 3)', 6],
        ['SUM({Lookup Prices})', 6],
        ['SUM()', 0],
        ['AVERAGE(1, 2, 3, 4)', 2.5],
        ['AVERAGE({Lookup Prices})', 2],
        ['AVERAGE(BLANK())', FORMULA_ERROR],
        ['MAX(1, 5, 3)', 5],
        ['MAX({Lookup Prices}, 10)', 10],
        ['MAX(BLANK())', 0],
        ['MIN(4, -2, 9)', -2],
        ['COUNT(1, "a", BLANK(), 2)', 2],
        ['COUNT({Lookup Prices})', 3],
        ['COUNTA(1, "a", BLANK(), "")', 2],
        ['COUNTA({Lookup Prices})', 4],
        ['COUNTALL(1, BLANK(), "")', 3],
        ['COUNTALL({Lookup Prices})', 5],
      ],
      record
    );
  });

  it('VALUE reads numbers from text', () => {
    expectCells([
      ['VALUE("$1,000")', 1000],
      ['VALUE("-12.5")', -12.5],
      ['VALUE("50%")', 0.5],
      ['VALUE("")', null],
      ['VALUE("ten")', FORMULA_ERROR],
    ]);
  });
});

describe('logical functions', () => {
  it('IF evaluates only the branch it takes', () => {
    expectCells(
      [
        ['IF({Price} > 10, "big", "small")', 'big'],
        ['IF({Qty}, "some", "none")', 'none'],
        ['IF(FALSE(), "x")', null],
        ['IF(TRUE(), "ok", ERROR())', 'ok'],
        ['IF(FALSE(), 1 / 0, 2)', 2],
        ['IF({Name}, "named", "unnamed")', 'unnamed'],
        ['IF({Tags}, "tagged", "untagged")', 'untagged'],
      ],
      { Price: 20, Qty: 0, Tags: [] }
    );
  });

  it('SWITCH matches patterns in order, with a default', () => {
    expectCells(
      [
        ['SWITCH({Status}, "Todo", 1, "Done", 2, 0)', 2],
        ['SWITCH({Status}, "Todo", 1)', null],
        ['SWITCH({Status}, "Todo", 1, "fallback")', 'fallback'],
        ['SWITCH(2, 1, "one", 2, "two")', 'two'],
        ['SWITCH(BLANK(), "", "empty", "x")', 'empty'],
      ],
      { Status: 'Done' }
    );
  });

  it('AND, OR, XOR, NOT, BLANK, ERROR, ISERROR, TRUE, FALSE', () => {
    expectCells([
      ['AND(1, "a", TRUE())', 1],
      ['AND(1, 0)', 0],
      ['AND(BLANK())', 0],
      ['OR(0, "", BLANK())', 0],
      ['OR(0, 1)', 1],
      ['XOR(1, 1, 1)', 1],
      ['XOR(1, 1)', 0],
      ['NOT(0)', 1],
      ['NOT("x")', 0],
      ['BLANK()', null],
      ['ERROR()', FORMULA_ERROR],
      ['ISERROR(ERROR())', 1],
      ['ISERROR(1 / 0)', 1],
      ['ISERROR(1 / 1)', 0],
      ['IF(ISERROR(SQRT(-1)), "bad", "good")', 'bad'],
      ['TRUE()', 1],
      ['FALSE()', 0],
    ]);
  });
});

describe('date functions', () => {
  const due = new FormulaDate(Date.parse('2026-03-31T00:00:00Z'), true);
  const start = new FormulaDate(Date.parse('2026-03-08T09:15:30.250Z'));
  const record = { Due: due, Start: start };
  const cases = (list: [string, unknown][]) => expectCells(list, record);

  it('NOW, TODAY, CREATED_TIME, LAST_MODIFIED_TIME, RECORD_ID', () => {
    cases([
      ['NOW()', '2026-10-26T15:30:45.123Z'],
      ['TODAY()', '2026-10-26'],
      ['CREATED_TIME()', '2026-01-02T03:04:05.000Z'],
      ['LAST_MODIFIED_TIME()', '2026-10-01T00:00:00.000Z'],
      ['RECORD_ID()', 'rec0190f5a27b3c'],
    ]);
  });

  it('DATEADD in fixed and calendar units', () => {
    cases([
      ['DATEADD("2026-07-10", 10, "days")', '2026-07-20'],
      ['DATEADD({Due}, 1, "month")', '2026-04-30'],
      ['DATEADD("2024-02-29", 1, "years")', '2025-02-28'],
      ['DATEADD({Due}, -1, "quarter")', '2025-12-31'],
      ['DATEADD({Due}, 2, "w")', '2026-04-14'],
      ['DATEADD({Start}, 90, "minutes")', '2026-03-08T10:45:30.250Z'],
      ['DATEADD({Start}, 1, "M")', '2026-04-08T09:15:30.250Z'],
      ['DATEADD({Start}, 1, "m")', '2026-03-08T09:16:30.250Z'],
      ['DATEADD(BLANK(), 1, "days")', null],
      ['DATEADD("not a date", 1, "days")', FORMULA_ERROR],
      ['DATEADD({Due}, 1, "parsecs")', FORMULA_ERROR],
    ]);
  });

  it('DATEADD keeps the wall clock across a DST change in the date time zone', () => {
    // 2026-03-08 is the US spring-forward day: +1 day keeps 09:00 local, so 23 hours pass.
    cases([
      [
        'DATETIME_FORMAT(DATEADD(SET_TIMEZONE("2026-03-07T14:00:00Z", "America/New_York"), 1, "day"), "YYYY-MM-DD HH:mm Z")',
        '2026-03-08 09:00 -04:00',
      ],
    ]);
  });

  it('DATETIME_DIFF truncates toward zero, months by the calendar', () => {
    cases([
      ['DATETIME_DIFF("2026-04-01", "2026-03-01", "days")', 31],
      ['DATETIME_DIFF("2026-03-01", "2026-04-01", "days")', -31],
      ['DATETIME_DIFF("2026-04-01", "2026-03-01")', 2678400],
      ['DATETIME_DIFF("2026-03-31", "2026-01-31", "months")', 2],
      ['DATETIME_DIFF("2026-03-30", "2026-01-31", "months")', 1],
      ['DATETIME_DIFF("2027-03-01", "2026-03-02", "years")', 0],
      ['DATETIME_DIFF("2027-03-02", "2026-03-02", "y")', 1],
      ['DATETIME_DIFF({Start}, "2026-03-08", "hours")', 9],
      ['DATETIME_DIFF("2026-01-15", "2026-01-01", "weeks")', 2],
      ['DATETIME_DIFF(BLANK(), "2026-01-01", "days")', null],
    ]);
  });

  it('DATETIME_FORMAT with moment tokens, locales and time zones', () => {
    cases([
      ['DATETIME_FORMAT({Start})', '2026-03-08T09:15:30.250+00:00'],
      ['DATETIME_FORMAT({Due}, "DD-MM-YYYY")', '31-03-2026'],
      ['DATETIME_FORMAT({Due}, "M/D/YY")', '3/31/26'],
      ['DATETIME_FORMAT({Due}, "MMMM Do, YYYY")', 'March 31st, 2026'],
      ['DATETIME_FORMAT({Due}, "ddd, MMM D")', 'Tue, Mar 31'],
      ['DATETIME_FORMAT({Due}, "dddd [the] Do")', 'Tuesday the 31st'],
      ['DATETIME_FORMAT({Start}, "h:mm A")', '9:15 AM'],
      ['DATETIME_FORMAT({Start}, "HH:mm:ss.SSS")', '09:15:30.250'],
      ['DATETIME_FORMAT({Due}, "LL")', 'March 31, 2026'],
      ['DATETIME_FORMAT({Due}, "Q W DDD")', '1 14 90'],
      ['DATETIME_FORMAT({Due}, "X")', '1774915200'],
      [
        'DATETIME_FORMAT(SET_TIMEZONE({Start}, "Asia/Kolkata"), "LLL Z")',
        'March 8, 2026 2:45 PM +05:30',
      ],
      ['DATETIME_FORMAT(SET_LOCALE({Due}, "fr"), "dddd D MMMM")', 'mardi 31 mars'],
      ['DATETIME_FORMAT(SET_LOCALE({Due}, "de"), "MMMM")', 'März'],
      ['DATETIME_FORMAT(BLANK(), "YYYY")', null],
    ]);
  });

  it('DATETIME_PARSE with and without a format', () => {
    cases([
      ['DATETIME_PARSE("2026-10-26")', '2026-10-26'],
      ['DATETIME_PARSE("2026-10-26T08:00:00+02:00")', '2026-10-26T06:00:00.000Z'],
      ['DATETIME_PARSE("4 Mar 2017 23:00", "D MMM YYYY HH:mm")', '2017-03-04T23:00:00.000Z'],
      ['DATETIME_PARSE("12/31/2026", "MM/DD/YYYY")', '2026-12-31T00:00:00.000Z'],
      [
        'DATETIME_PARSE("March 3rd, 2026 5:30 pm", "MMMM Do, YYYY h:mm a")',
        '2026-03-03T17:30:00.000Z',
      ],
      ['DATETIME_PARSE("1774915200", "X")', '2026-03-31T00:00:00.000Z'],
      ['DATETIME_PARSE("31/02/2026", "DD/MM/YYYY")', FORMULA_ERROR],
      ['DATETIME_PARSE("nonsense", "YYYY-MM-DD")', FORMULA_ERROR],
      ['DATETIME_PARSE("nonsense")', FORMULA_ERROR],
      ['DATETIME_PARSE("")', null],
    ]);
  });

  it('DAY, MONTH, YEAR, HOUR, MINUTE, SECOND (UTC unless a time zone is set)', () => {
    cases([
      ['DAY({Due})', 31],
      ['MONTH({Due})', 3],
      ['YEAR({Due})', 2026],
      ['HOUR({Start})', 9],
      ['MINUTE({Start})', 15],
      ['SECOND({Start})', 30],
      ['HOUR(SET_TIMEZONE({Start}, "America/Los_Angeles"))', 1],
      ['DAY(SET_TIMEZONE("2026-03-31T23:30:00Z", "Europe/Berlin"))', 1],
      ['DAY(BLANK())', null],
      ['YEAR("2021-06-15")', 2021],
    ]);
  });

  it('WEEKDAY and WEEKNUM', () => {
    cases([
      ['WEEKDAY({Due})', 2],
      ['WEEKDAY({Due}, "Monday")', 1],
      ['WEEKDAY("2026-03-29")', 0],
      ['WEEKDAY("2026-03-29", "Monday")', 6],
      ['WEEKDAY({Due}, "Friday")', FORMULA_ERROR],
      ['WEEKNUM("2026-01-01")', 1],
      ['WEEKNUM("2026-01-04")', 2],
      ['WEEKNUM("2026-01-04", "Monday")', 1],
      ['WEEKNUM({Due})', 14],
    ]);
  });

  it('WORKDAY and WORKDAY_DIFF skip weekends and holidays', () => {
    cases([
      ['WORKDAY("2026-10-23", 1)', '2026-10-26'],
      ['WORKDAY("2026-10-26", 5)', '2026-11-02'],
      ['WORKDAY("2026-10-26", -1)', '2026-10-23'],
      ['WORKDAY("2026-12-24", 1, "2026-12-25")', '2026-12-28'],
      ['WORKDAY("2026-10-26", 0)', '2026-10-26'],
      ['WORKDAY("2026-10-26", 1000000)', FORMULA_ERROR],
      ['WORKDAY_DIFF("2026-10-26", "2026-11-06")', 10],
      ['WORKDAY_DIFF("2026-11-06", "2026-10-26")', -10],
      ['WORKDAY_DIFF("2026-10-24", "2026-10-25")', 0],
      ['WORKDAY_DIFF("2026-12-21", "2026-12-31", "2026-12-25, 2026-12-26")', 8],
      ['WORKDAY_DIFF("2026-01-01", "2026-12-31")', 261],
      ['WORKDAY_DIFF("2026-01-01", "2026-12-31", "not a date")', FORMULA_ERROR],
    ]);
  });

  it('SET_TIMEZONE and SET_LOCALE validate their argument', () => {
    cases([
      ['SET_TIMEZONE({Start}, "Mars/Olympus")', FORMULA_ERROR],
      ['SET_LOCALE({Start}, "")', FORMULA_ERROR],
      ['SET_TIMEZONE(BLANK(), "UTC")', null],
    ]);
  });

  it('IS_BEFORE, IS_AFTER and IS_SAME (to a unit)', () => {
    cases([
      ['IS_BEFORE({Start}, {Due})', 1],
      ['IS_AFTER({Start}, {Due})', 0],
      ['IS_BEFORE(BLANK(), {Due})', 0],
      ['IS_SAME("2026-03-08", {Start}, "day")', 1],
      ['IS_SAME("2026-03-08", {Start})', 0],
      ['IS_SAME({Due}, "2026-03-01", "month")', 1],
      ['IS_SAME({Due}, "2026-04-01", "month")', 0],
      ['IS_SAME({Due}, "2026-01-01", "year")', 1],
      ['IS_SAME({Due}, "2026-01-01", "quarter")', 1],
    ]);
  });

  it('DATESTR, TIMESTR, TONOW, FROMNOW', () => {
    cases([
      ['DATESTR({Start})', '2026-03-08'],
      ['TIMESTR({Start})', '09:15:30'],
      ['TONOW("2026-10-20")', 6],
      ['FROMNOW("2026-10-30", "days")', 3],
    ]);
  });
});

describe('array functions', () => {
  const record = { Tags: ['b', 'a', 'b', '', 'c'] };
  it('ARRAYJOIN, ARRAYUNIQUE, ARRAYCOMPACT, ARRAYFLATTEN, ARRAYSLICE', () => {
    expectCells(
      [
        ['ARRAYJOIN({Tags}, "; ")', 'b; a; b; ; c'],
        ['ARRAYJOIN({Tags})', 'b, a, b, , c'],
        ['ARRAYJOIN(ARRAYUNIQUE({Tags}), "|")', 'b|a||c'],
        ['ARRAYJOIN(ARRAYCOMPACT({Tags}), "|")', 'b|a|b|c'],
        ['ARRAYJOIN(ARRAYFLATTEN({Tags}), "|")', 'b|a|b||c'],
        ['ARRAYJOIN(ARRAYSLICE({Tags}, 2, 3), "|")', 'a|b'],
        ['ARRAYJOIN(ARRAYSLICE({Tags}, -2), "|")', '|c'],
        ['ARRAYJOIN(ARRAYSLICE({Tags}, 4), "|")', '|c'],
        ['ARRAYSLICE({Tags}, 0)', FORMULA_ERROR],
        ['ARRAYJOIN(BLANK())', null],
        ['ARRAYUNIQUE({Tags})', 'b, a, , c'],
      ],
      record
    );
  });
});

describe('evaluateFormula', () => {
  it('stops a formula that exceeds the step budget', () => {
    const result = run('LEN(REPT("abc", 30000))', {}, { maxSteps: 50 });
    expect(result).toMatchObject({ ok: false, budget: true });
  });

  it('does not let ISERROR swallow an exhausted budget', () => {
    const result = run('ISERROR(REPT("abc", 30000))', {}, { maxSteps: 50 });
    expect(result).toMatchObject({ ok: false, budget: true });
  });

  it('reads field values through the registry', () => {
    const v = (type: string, value: unknown, options: unknown = {}) =>
      fieldFormulaValue({ type, options }, value);
    expect(v('number', 3)).toBe(3);
    expect(v('checkbox', true)).toBe(true);
    expect(v('date', '2026-10-26')).toEqual(
      new FormulaDate(Date.parse('2026-10-26T00:00:00Z'), true)
    );
    expect(v('dateTime', '2026-10-26T10:00:00.000Z')).toEqual(
      new FormulaDate(Date.parse('2026-10-26T10:00:00.000Z'))
    );
    expect(v('singleLineText', 'hi')).toBe('hi');
    expect(v('singleLineText', null)).toBeNull();
    expect(v('lookup', ['a', 'b'])).toEqual(['a', 'b']);
    expect(v('rollup', 12)).toBe(12);
    expect(v('notAType', 'x')).toBeNull();
  });

  it('never throws on generated formulas over random values', () => {
    const names = Object.keys(FORMULA_FUNCTIONS);
    const value = fc.oneof(
      fc.constant(null),
      fc.double({ noNaN: false }),
      fc.string({ maxLength: 20 }),
      fc.boolean(),
      fc.array(fc.oneof(fc.string({ maxLength: 5 }), fc.integer()), { maxLength: 4 })
    );
    const literal = fc.oneof(
      fc.integer({ min: -1000, max: 1000 }).map(String),
      fc.constantFrom('"a"', '""', '"2026-10-26"', '"day"', '"months"', '"YYYY"', '"[a-z]+"'),
      fc.constantFrom('{Name}', '{Price}', '{Due}', '{Tags}', '{Done}')
    );
    const expr = fc.letrec<{ e: string }>((tie) => ({
      e: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        literal,
        fc
          .tuple(fc.constantFrom(...names), fc.array(tie('e'), { maxLength: 4 }))
          .map(([n, args]) => `${n}(${args.join(', ')})`),
        fc
          .tuple(tie('e'), fc.constantFrom('+', '-', '*', '/', '&', '=', '<'), tie('e'))
          .map(([a, op, b]) => `(${a} ${op} ${b})`)
      ),
    })).e;
    fc.assert(
      fc.property(expr, value, value, value, (source, a, b, c) => {
        const parsed = parseFormula(source, { fields });
        if (!parsed.ok) return;
        const values = new Map<string, FormulaValue>([
          [idOf('Name'), a as FormulaValue],
          [idOf('Price'), b as FormulaValue],
          [idOf('Tags'), c as FormulaValue],
        ]);
        const result = evaluateFormula(parsed.ast, {
          field: (id) => values.get(id) ?? null,
          now: NOW,
        });
        if (!result.ok) expect(result.message).not.toBe('The formula could not be evaluated');
        const stored = formulaResult(result);
        expect(stored === null || typeof stored === 'number' || typeof stored === 'string').toBe(
          true
        );
      }),
      { numRuns: 2000 }
    );
  });
});
