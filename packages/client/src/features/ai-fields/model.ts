import {
  type AiCellStatus,
  type AiFieldStatus,
  type AiOptions,
  aiOptionsSchema,
  type Choice,
  type FieldMeta,
} from '@openrows/shared';

/**
 * AI fields in the app: a cell's generation state from the field's status answer, the
 * choice an answer names, and the header menu's summary.
 */

export interface AiCellState {
  status: AiCellStatus;
  error: string | null;
}

/** The field's options, defaults applied. */
export function aiOptions(field: Pick<FieldMeta, 'options'>): AiOptions {
  const parsed = aiOptionsSchema.safeParse(field.options ?? {});
  return parsed.success ? parsed.data : aiOptionsSchema.parse({});
}

/** Records not done, by id (a done cell isn't listed: it has no state to show). */
export function cellStates(status: AiFieldStatus | undefined): Map<string, AiCellState> {
  return new Map(
    (status?.cells ?? []).map((c) => [c.recordId, { status: c.status, error: c.error }])
  );
}

/** The choice a select answer names (answers are stored by name), or null. */
export function answerChoice(field: Pick<FieldMeta, 'options'>, value: unknown): Choice | null {
  const options = aiOptions(field);
  if (options.output !== 'singleSelect' || typeof value !== 'string') return null;
  return options.choices.find((c) => c.name === value) ?? null;
}

/** "12 generating, 2 failed": the header menu's line; null when nothing is pending or failed. */
export function statusSummary(status: AiFieldStatus | undefined): string | null {
  if (!status) return null;
  const parts: string[] = [];
  if (status.counts.pending) parts.push(`${status.counts.pending} generating`);
  if (status.counts.error) parts.push(`${status.counts.error} failed`);
  if (status.counts.canceled) parts.push(`${status.counts.canceled} stopped`);
  return parts.length ? parts.join(', ') : null;
}
