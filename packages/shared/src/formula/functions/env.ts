import type { FormulaValue } from './values.js';

/** What a function sees of the record and the evaluation. */
export interface EvalEnv {
  /** The time `NOW()` and `TODAY()` read, in UTC ms. */
  readonly now: number;
  readonly recordId: string | null;
  /** The record's creation and last change, in UTC ms. */
  readonly createdTime: number | null;
  readonly lastModifiedTime: number | null;
  /** Charges `n` steps of work (long texts, day loops) to the evaluation's budget. */
  step(n?: number): void;
}

/** An eagerly evaluated function: its arguments are values. */
export type FunctionImpl = (args: FormulaValue[], env: EvalEnv) => FormulaValue;
