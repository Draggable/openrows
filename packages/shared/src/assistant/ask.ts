import { z } from 'zod';
import { ASSISTANT_PROMPT_MAX } from './plan.js';

/**
 * Questions about the open base: the assistant answers in text from what the asker can
 * already see (the schema, the views and automations they may read, and records only on
 * opt-in). An answer is never a change plan; nothing is applied or written.
 */

/** Records read from the open table or view for a question, at most (with `includeRecords`). */
export const ASSISTANT_ASK_RECORDS = 25;
/** The longest answer returned; a longer one is cut. */
export const ASSISTANT_ANSWER_MAX = 4000;

/** `POST /api/bases/:baseId/assistant/ask`. */
export const assistantAskRequestSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(ASSISTANT_PROMPT_MAX),
    /**
     * Send records the asker may read to the model (off by default: the schema only). With
     * `tableId` (and `viewId`), up to ASSISTANT_ASK_RECORDS of that table, through the view's
     * filter; else a few of each table, as plans sample them.
     */
    includeRecords: z.boolean().default(false),
    /** The open table, if any: its records are the ones read. */
    tableId: z.uuid().optional(),
    /** The open view of `tableId`, if any: its filter and hidden fields apply to the records. */
    viewId: z.uuid().optional(),
  })
  .refine((q) => q.viewId === undefined || q.tableId !== undefined, {
    message: 'A view needs its table.',
    path: ['viewId'],
  });
export type AssistantAskRequest = z.input<typeof assistantAskRequestSchema>;

/** What the model answers (structured output). */
export const assistantAnswerOutputSchema = z.strictObject({ answer: z.string() });

export const AssistantAnswerSchema = z.strictObject({
  /** Plain text, at most ASSISTANT_ANSWER_MAX characters. */
  answer: z.string().max(ASSISTANT_ANSWER_MAX),
  /** Records the model read for this answer (0 without `includeRecords`). */
  records: z.int().min(0),
});
export type AssistantAnswer = z.infer<typeof AssistantAnswerSchema>;
