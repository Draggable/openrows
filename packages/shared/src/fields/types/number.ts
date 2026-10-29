import { z } from 'zod';
import { numberLike, precisionSchema, readPlainNumber } from '../number-like.js';
import { formatNumber } from '../util.js';

/** A decimal number with a fixed number of decimals (`precision`, 0-8). */
export const number = numberLike({
  name: 'number',
  label: 'Number',
  optionsSchema: z
    .object({ precision: precisionSchema(0), allowNegative: z.boolean().default(true) })
    .strict(),
  editor: { kind: 'number', align: 'right', width: 110 },
  storedDecimals: (o) => o.precision,
  read: readPlainNumber,
  format: (value, o, ctx) =>
    formatNumber(value, ctx?.locale, {
      minimumFractionDigits: o.precision,
      maximumFractionDigits: o.precision,
    }),
});
