// The formula function catalog: Airtable's functions with their argument kinds and result type.
// The type checker reads it; the evaluator implements the same names.

/**
 * A formula value's type. Dates cover date and date-time values; `array` covers lists (multiple
 * selects, attachments, lookups); `null` is `BLANK()`; `any` is unknown until evaluation (mixed
 * `IF` branches, `ERROR()`, a call that didn't type-check).
 */
export type FormulaType = 'text' | 'number' | 'date' | 'boolean' | 'array' | 'null' | 'any';

export const FORMULA_TYPES: readonly FormulaType[] = [
  'text',
  'number',
  'date',
  'boolean',
  'array',
  'null',
  'any',
];

/**
 * What an argument accepts. Airtable converts freely, so:
 * - `any`, `text` and `boolean` take every type (text is converted, booleans test truthiness);
 * - `number` takes numbers and booleans (1/0);
 * - `numbers` (aggregates like SUM) also takes arrays;
 * - `date` takes dates and text (parsed as a date);
 * - `array` takes arrays;
 * - `unit` is text naming a date unit, checked when it's a literal.
 * `null` and `any` are accepted everywhere.
 */
export type ArgKind = 'any' | 'text' | 'number' | 'numbers' | 'date' | 'boolean' | 'array' | 'unit';

export interface FunctionSignature {
  /** Fixed arguments, in order. */
  args: readonly ArgKind[];
  /** How many of `args` are required (the rest are optional). */
  required: number;
  /** Extra arguments of this kind may follow `args`. */
  rest?: ArgKind;
  /** Upper bound on the argument count with `rest` (sanity cap). */
  maxArgs?: number;
  /** The result type, or `join` of the arguments at these indexes (IF, SWITCH). */
  returns: FormulaType | 'join';
  description: string;
}

function fn(
  returns: FunctionSignature['returns'],
  spec: string,
  description: string
): FunctionSignature {
  // `spec`: comma-separated kinds; `?` marks optional, a trailing `...` repeats the last one.
  const parts = spec === '' ? [] : spec.split(',').map((s) => s.trim());
  const args: ArgKind[] = [];
  let required = 0;
  let rest: ArgKind | undefined;
  for (const part of parts) {
    if (part.endsWith('...')) {
      rest = part.slice(0, -3) as ArgKind;
      continue;
    }
    const optional = part.endsWith('?');
    args.push((optional ? part.slice(0, -1) : part) as ArgKind);
    if (!optional) required = args.length;
  }
  return { args, required, rest, returns, description, maxArgs: rest ? 255 : undefined };
}

/** Every function, by upper-case name. */
export const FORMULA_FUNCTIONS: Readonly<Record<string, FunctionSignature>> = {
  // Text
  ARRAYJOIN: fn('text', 'array, text?', 'Joins the items of a list with a separator'),
  CONCATENATE: fn('text', 'text, text...', 'Joins values into one text'),
  ENCODE_URL_COMPONENT: fn('text', 'text', 'Encodes text for use in a URL'),
  FIND: fn('number', 'text, text, number?', 'Position of a text in another (case-sensitive)'),
  LEFT: fn('text', 'text, number', 'The first characters of a text'),
  LEN: fn('number', 'text', 'The number of characters'),
  LOWER: fn('text', 'text', 'Lower-cases a text'),
  MID: fn('text', 'text, number, number', 'Characters from the middle of a text'),
  REPLACE: fn('text', 'text, number, number, text', 'Replaces characters at a position'),
  REPT: fn('text', 'text, number', 'Repeats a text'),
  RIGHT: fn('text', 'text, number', 'The last characters of a text'),
  SEARCH: fn('number', 'text, text, number?', 'Position of a text in another (ignores case)'),
  SUBSTITUTE: fn('text', 'text, text, text, number?', 'Replaces occurrences of a text'),
  T: fn('text', 'any', 'The value if it is text, else empty'),
  TRIM: fn('text', 'text', 'Removes leading and trailing whitespace'),
  UPPER: fn('text', 'text', 'Upper-cases a text'),
  REGEX_MATCH: fn('boolean', 'text, text', 'Whether the text matches a regular expression'),
  REGEX_EXTRACT: fn('text', 'text, text', 'The first match of a regular expression'),
  REGEX_REPLACE: fn('text', 'text, text, text', 'Replaces every match of a regular expression'),
  // Logical
  AND: fn('boolean', 'boolean, boolean...', 'Whether every argument is true'),
  OR: fn('boolean', 'boolean, boolean...', 'Whether any argument is true'),
  XOR: fn('boolean', 'boolean, boolean...', 'Whether an odd number of arguments is true'),
  NOT: fn('boolean', 'boolean', 'The opposite of a boolean'),
  IF: fn('join', 'boolean, any, any?', 'One value if a condition is true, another if not'),
  SWITCH: fn('join', 'any, any, any...', 'The result whose pattern matches the expression'),
  BLANK: fn('null', '', 'An empty value'),
  ERROR: fn('any', '', 'An error value'),
  ISERROR: fn('boolean', 'any', 'Whether the expression gives an error'),
  TRUE: fn('boolean', '', 'True'),
  FALSE: fn('boolean', '', 'False'),
  // Numeric
  ABS: fn('number', 'number', 'The absolute value'),
  AVERAGE: fn('number', 'numbers, numbers...', 'The mean of the numbers'),
  CEILING: fn('number', 'number, number?', 'Rounds up to a multiple of the significance'),
  COUNT: fn('number', 'any, any...', 'How many arguments are numbers'),
  COUNTA: fn('number', 'any, any...', 'How many arguments are not empty'),
  COUNTALL: fn('number', 'any, any...', 'How many arguments, empty ones included'),
  EVEN: fn('number', 'number', 'Rounds away from zero to an even integer'),
  EXP: fn('number', 'number', 'e raised to a power'),
  FLOOR: fn('number', 'number, number?', 'Rounds down to a multiple of the significance'),
  INT: fn('number', 'number', 'Rounds down to an integer'),
  LOG: fn('number', 'number, number?', 'The logarithm in a base (10 by default)'),
  MAX: fn('number', 'numbers, numbers...', 'The largest number'),
  MIN: fn('number', 'numbers, numbers...', 'The smallest number'),
  MOD: fn('number', 'number, number', 'The remainder of a division'),
  ODD: fn('number', 'number', 'Rounds away from zero to an odd integer'),
  POWER: fn('number', 'number, number', 'A number raised to a power'),
  ROUND: fn('number', 'number, number?', 'Rounds to a number of decimals'),
  ROUNDDOWN: fn('number', 'number, number?', 'Rounds towards zero to a number of decimals'),
  ROUNDUP: fn('number', 'number, number?', 'Rounds away from zero to a number of decimals'),
  SQRT: fn('number', 'number', 'The square root'),
  SUM: fn('number', 'numbers, numbers...', 'The sum of the numbers'),
  VALUE: fn('number', 'text', 'Reads a number from a text'),
  // Date and time
  CREATED_TIME: fn('date', '', "The record's creation time"),
  DATEADD: fn('date', 'date, number, unit', 'Adds a count of units to a date'),
  DATESTR: fn('text', 'date', 'A date as YYYY-MM-DD'),
  DATETIME_DIFF: fn('number', 'date, date, unit?', 'The difference between two dates in units'),
  DATETIME_FORMAT: fn('text', 'date, text?', 'Formats a date'),
  DATETIME_PARSE: fn('date', 'text, text?, text?', 'Reads a date from a text'),
  DAY: fn('number', 'date', 'The day of the month'),
  HOUR: fn('number', 'date', 'The hour (0-23)'),
  IS_AFTER: fn('boolean', 'date, date', 'Whether the first date is after the second'),
  IS_BEFORE: fn('boolean', 'date, date', 'Whether the first date is before the second'),
  IS_SAME: fn('boolean', 'date, date, unit?', 'Whether two dates are the same, to a unit'),
  LAST_MODIFIED_TIME: fn('date', 'any...', 'When the record (or the given fields) last changed'),
  MINUTE: fn('number', 'date', 'The minute (0-59)'),
  MONTH: fn('number', 'date', 'The month (1-12)'),
  NOW: fn('date', '', 'The current date and time'),
  SECOND: fn('number', 'date', 'The second (0-59)'),
  SET_LOCALE: fn('date', 'date, text', 'Sets the locale used to format a date'),
  SET_TIMEZONE: fn('date', 'date, text', 'Sets the time zone used to format a date'),
  TIMESTR: fn('text', 'date', 'A time as HH:mm:ss'),
  TONOW: fn('number', 'date, unit?', 'The time from a date to now'),
  FROMNOW: fn('number', 'date, unit?', 'The time from now to a date'),
  TODAY: fn('date', '', "Today's date"),
  WEEKDAY: fn('number', 'date, text?', 'The day of the week (0 = Sunday)'),
  WEEKNUM: fn('number', 'date, text?', 'The week of the year'),
  WORKDAY: fn('date', 'date, number, text?', 'The date a number of working days later'),
  WORKDAY_DIFF: fn('number', 'date, date, text?', 'The working days between two dates'),
  YEAR: fn('number', 'date', 'The year'),
  // Arrays
  ARRAYCOMPACT: fn('array', 'array', 'The list without empty items'),
  ARRAYFLATTEN: fn('array', 'array', 'Flattens nested lists'),
  ARRAYUNIQUE: fn('array', 'array', 'The list without duplicates'),
  ARRAYSLICE: fn('array', 'array, number, number?', 'A part of the list'),
  // Record
  RECORD_ID: fn('text', '', "The record's id"),
};

/** Date units for DATEADD, DATETIME_DIFF, IS_SAME, TONOW and FROMNOW (as in Airtable). */
export const DATE_UNITS: readonly string[] = [
  'milliseconds',
  'millisecond',
  'ms',
  'seconds',
  'second',
  's',
  'minutes',
  'minute',
  'm',
  'hours',
  'hour',
  'h',
  'days',
  'day',
  'd',
  'weeks',
  'week',
  'w',
  'months',
  'month',
  'M',
  'quarters',
  'quarter',
  'Q',
  'years',
  'year',
  'y',
];
