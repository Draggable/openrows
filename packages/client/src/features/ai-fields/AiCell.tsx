import type { FieldMeta } from '@openrows/shared';
import { CircleAlert, CircleStop, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '../../api/client';
import { useAiFieldStatus, useCancelAiField, useGenerateAiField } from '../../api/queries';
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '../../components/ui';
import { cn } from '../../lib/utils';
import { ChoiceChip } from '../grid/cells/CellContent';
import { cellText } from '../grid/cells/model';
import { answerChoice, cellStates, statusSummary } from './model';

/** A cell's generation state, from the field's status (one query per field, shared by cells). */
function useAiCell(fieldId: string, recordId: string) {
  const status = useAiFieldStatus(fieldId);
  return cellStates(status.data).get(recordId) ?? null;
}

/** The answer itself: a select answer as its option's chip, other answers as text. */
function Answer({ field, value }: { field: FieldMeta; value: unknown }) {
  const choice = answerChoice(field, value);
  if (choice) return <ChoiceChip choice={choice} />;
  return <span className="truncate">{cellText(field, value)}</span>;
}

/**
 * An AI field's cell in the grid: the answer, with "Generating…" while the worker is on it
 * and an error mark (its message as the tooltip) when the last attempt failed; the value is kept
 * either way.
 */
export function AiCell({
  field,
  value,
  recordId,
}: {
  field: FieldMeta;
  value: unknown;
  recordId: string;
}) {
  const state = useAiCell(field.id, recordId);
  const empty = value === null || value === undefined || value === '';
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {state?.status === 'pending' && (
        <LoaderCircle
          className="size-3.5 shrink-0 animate-spin text-text-3 motion-reduce:animate-none"
          aria-label="Generating"
        />
      )}
      {state?.status === 'error' && (
        <span title={state.error ?? 'The answer failed'} className="flex shrink-0">
          <CircleAlert className="size-3.5 text-danger" aria-label="Generation failed" />
        </span>
      )}
      {empty && state?.status === 'pending' ? (
        <span className="truncate text-text-3">Generating…</span>
      ) : (
        <Answer field={field} value={value} />
      )}
    </span>
  );
}

/** The record view's AI value: the answer, its state and message, and "Regenerate". */
export function AiRecordValue({
  field,
  value,
  recordId,
  canRegenerate,
}: {
  field: FieldMeta;
  value: unknown;
  recordId: string;
  canRegenerate: boolean;
}) {
  const state = useAiCell(field.id, recordId);
  const generate = useGenerateAiField(field.id);
  const pending = state?.status === 'pending' || generate.isPending;
  return (
    <div className="grid min-w-0 gap-1 py-1">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', pending && 'text-text-3')}
        >
          {pending && (value === null || value === undefined) ? (
            'Generating…'
          ) : (
            <Answer field={field} value={value} />
          )}
        </span>
        {canRegenerate && (
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              generate.mutate(
                { recordIds: [recordId] },
                {
                  onError: (err) =>
                    toast.error(err instanceof ApiError ? err.message : "Couldn't regenerate."),
                }
              )
            }
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 text-small text-text-2 outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
          >
            <RefreshCw
              className={cn('size-3.5', pending && 'animate-spin motion-reduce:animate-none')}
              aria-hidden
            />
            {pending ? 'Generating…' : 'Regenerate'}
          </button>
        )}
      </div>
      {state?.status === 'error' && state.error && (
        <p role="status" className="flex items-center gap-1.5 text-small text-danger">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {state.error}
        </p>
      )}
      {state?.status === 'canceled' && (
        <p className="text-small text-text-3">Stopped before it was generated.</p>
      )}
    </div>
  );
}

/**
 * The column menu's AI items (creators): generate the missing answers, all of them again,
 * or stop what's pending; with the field's state ("12 generating, 2 failed").
 */
export function AiFieldMenuItems({ field }: { field: FieldMeta }) {
  const status = useAiFieldStatus(field.id);
  const generate = useGenerateAiField(field.id);
  const cancel = useCancelAiField(field.id);
  const summary = statusSummary(status.data);
  const fail = (err: unknown) =>
    toast.error(err instanceof ApiError ? err.message : "Couldn't start the generation.");
  // The menu closes (and this unmounts) before the answer: promises, not mutate's callbacks.
  const run = (scope: 'all' | 'missing') =>
    generate
      .mutateAsync({ scope })
      .then(({ queued }) =>
        toast.success(
          queued
            ? `Generating ${queued} ${queued === 1 ? 'answer' : 'answers'}`
            : 'Nothing to generate'
        )
      )
      .catch(fail);
  const stop = () =>
    cancel
      .mutateAsync()
      .then(({ canceled }) => toast.success(`Stopped ${canceled} pending`))
      .catch(fail);
  return (
    <>
      {summary && (
        <DropdownMenuLabel className="font-normal text-small text-text-2">
          {summary}
        </DropdownMenuLabel>
      )}
      <DropdownMenuItem onSelect={() => void run('missing')}>
        <Sparkles aria-hidden />
        Generate missing answers
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void run('all')}>
        <RefreshCw aria-hidden />
        Regenerate all
      </DropdownMenuItem>
      {(status.data?.counts.pending ?? 0) > 0 && (
        <DropdownMenuItem onSelect={() => void stop()}>
          <CircleStop aria-hidden />
          Stop generating
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
    </>
  );
}
