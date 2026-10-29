import { z } from 'zod';
import { numberLike, precisionSchema } from '../number-like.js';
import { formatNumber, readNumber } from '../util.js';

/**
 * A percentage, stored as a fraction (`0.5` is 50%), as in Airtable's API. Typed text is in
 * percent with or without `%` (`'50'` and `'50%'` are both 0.5); a number input is a fraction.
 * `precision` counts the displayed percent decimals.
 */
export const percent = numberLike({
  name: 'percent',
  label: 'Percent',
  optionsSchema: z
    .object({ precision: precisionSchema(0), allowNegative: z.boolean().default(true) })
    .strict(),
  editor: { kind: 'number', align: 'right', width: 110 },
  storedDecimals: (o) => o.precision + 2,
  read: (input) => {
    const n = readNumber(input);
    if (!n) return null;
    return typeof input === 'string' ? n.value / 100 : n.value;
  },
  format: (value, o, ctx) =>
    formatNumber(value, ctx?.locale, {
      style: 'percent',
      minimumFractionDigits: o.precision,
      maximumFractionDigits: o.precision,
    }),
});
