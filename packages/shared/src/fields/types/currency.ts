import { z } from 'zod';
import { numberLike, precisionSchema, readPlainNumber } from '../number-like.js';
import { formatNumber } from '../util.js';

/** An amount in one ISO 4217 currency (`currencyCode`), default 2 decimals. */
export const currency = numberLike({
  name: 'currency',
  label: 'Currency',
  optionsSchema: z
    .object({
      precision: precisionSchema(2),
      allowNegative: z.boolean().default(true),
      currencyCode: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .default('USD'),
    })
    .strict(),
  editor: { kind: 'number', align: 'right', width: 110 },
  storedDecimals: (o) => o.precision,
  read: readPlainNumber,
  format: (value, o, ctx) =>
    formatNumber(value, ctx?.locale, {
      style: 'currency',
      currency: o.currencyCode,
      minimumFractionDigits: o.precision,
      maximumFractionDigits: o.precision,
    }),
});
