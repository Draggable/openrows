import type { AssistantApplyResult, AssistantPlan, AssistantPlanResult } from '@openrows/shared';
import { ASSISTANT_PROMPT_MAX } from '@openrows/shared';
import { useNavigate } from '@tanstack/react-router';
import { CircleAlertIcon, SparklesIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { ApiError } from '../../api/client';
import {
  useApplyAssistantBasePlan,
  useApplyAssistantPlan,
  useAssistantBasePlan,
  useAssistantPlan,
} from '../../api/queries';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
  toast,
} from '../../components/ui';
import { changeCount, initialSelection, planRows, selectedPlan } from './model';

function errorText(err: unknown, fallback: string): string[] {
  if (!(err instanceof ApiError)) return [fallback];
  const errors = (err.data as { errors?: { message?: unknown }[] } | undefined)?.errors;
  const details = (errors ?? []).map((e) => String(e.message ?? '')).filter(Boolean);
  return [err.message, ...details];
}

interface PanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Describe it": the plan builds a new base, named in the panel. */
  newBase: boolean;
  plan: (prompt: string, includeRecords: boolean) => Promise<AssistantPlanResult>;
  planning: boolean;
  apply: (plan: AssistantPlan, name: string) => Promise<AssistantApplyResult>;
  applying: boolean;
  onApplied: (result: AssistantApplyResult) => void;
}

/**
 * The AI assistant: the user describes a change, the assistant drafts a plan from the
 * base's schema (records only when the box is ticked), and the plan shows as a list of
 * additions, each ticked unless it has a problem. Nothing changes until "Apply"; closing or
 * "Discard" drops the plan.
 */
function AssistantPanel(props: PanelProps) {
  const { open, onOpenChange, newBase } = props;
  const [prompt, setPrompt] = useState('');
  const [includeRecords, setIncludeRecords] = useState(false);
  const [result, setResult] = useState<AssistantPlanResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [name, setName] = useState('');
  const [error, setError] = useState<string[] | null>(null);
  const promptId = useId();
  const recordsHint = useId();
  const nameId = useId();

  const reset = () => {
    setResult(null);
    setSelected(new Set());
    setError(null);
  };
  const draft = async () => {
    if (!prompt.trim() || props.planning) return;
    reset();
    try {
      const r = await props.plan(prompt.trim(), includeRecords);
      setResult(r);
      setSelected(initialSelection(r.plan, r.problems));
      setName(r.plan.baseName ?? '');
    } catch (err) {
      setError(errorText(err, "The assistant couldn't draft a plan."));
    }
  };
  const confirm = async () => {
    if (!result || selected.size === 0) return;
    setError(null);
    try {
      const applied = await props.apply(selectedPlan(result.plan, selected), name.trim());
      toast.success(`Applied ${changeCount(selected.size)}`);
      reset();
      setPrompt('');
      onOpenChange(false);
      props.onApplied(applied);
    } catch (err) {
      setError(errorText(err, "The plan couldn't be applied."));
    }
  };
  const toggle = (i: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const rows = result ? planRows(result.plan, result.problems) : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-4 text-primary" aria-hidden />
            {newBase ? 'Describe a new base' : 'Assistant'}
          </DialogTitle>
          <DialogDescription>
            {newBase
              ? 'Say what you want to track. The assistant drafts the tables, fields and views; nothing is created until you apply the plan.'
              : "Ask for tables, fields, formulas, views or automations. The assistant drafts a plan from this base's tables and fields; nothing changes until you apply it."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void draft();
          }}
        >
          <label htmlFor={promptId} className="font-medium">
            {newBase ? 'What do you want to track?' : 'What should change?'}
          </label>
          <textarea
            id={promptId}
            value={prompt}
            maxLength={ASSISTANT_PROMPT_MAX}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void draft();
              }
            }}
            placeholder={
              newBase
                ? 'A CRM for a small agency: companies, contacts and deals by stage'
                : 'Add a Total formula to Orders and a kanban view by status'
            }
            className="min-h-20 w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-body text-text placeholder:text-text-3 hover:border-border-strong"
          />
          {!newBase && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeRecords}
                onChange={(e) => setIncludeRecords(e.target.checked)}
                aria-describedby={recordsHint}
                className="accent-primary"
              />
              Include a few records from each table
            </label>
          )}
          {!newBase && (
            <p id={recordsHint} className="text-small text-text-2">
              {includeRecords
                ? 'Up to 3 records per table go to the AI provider with the request.'
                : 'Off: the AI provider sees table and field names only, no records.'}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={!prompt.trim() || props.planning}>
              {props.planning ? <Spinner /> : <SparklesIcon />}
              {props.planning ? 'Drafting…' : result ? 'Draft again' : 'Draft plan'}
            </Button>
          </div>
        </form>

        {error && (
          <div role="alert" className="rounded-md border border-border bg-hover px-3 py-2">
            {error.map((line) => (
              <p key={line} className="flex gap-2">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
                {line}
              </p>
            ))}
          </div>
        )}

        {result && (
          <section aria-label="Proposed changes" className="flex min-h-0 flex-col gap-3">
            <p className="text-text-2">{result.plan.summary}</p>
            {newBase && (
              <div className="grid gap-1">
                <label htmlFor={nameId} className="font-medium">
                  Base name
                </label>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={255}
                />
              </div>
            )}
            {rows.length === 0 ? (
              <p>The assistant proposed no changes. Try describing it differently.</p>
            ) : (
              <ul className="min-h-0 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {rows.map((row) => (
                  <li key={row.index} className="px-3 py-2">
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(row.index)}
                        onChange={() => toggle(row.index)}
                        className="mt-1 accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">
                          <span aria-hidden className="mr-1 font-mono text-primary">
                            +
                          </span>
                          {row.title}
                        </span>
                        {row.details.map((d) => (
                          <span key={d} className="block truncate font-mono text-small text-text-2">
                            {d}
                          </span>
                        ))}
                        {row.problems.map((p) => (
                          <span key={p} className="flex gap-1 text-small text-danger">
                            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                            {p}
                          </span>
                        ))}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={reset}>
                Discard
              </Button>
              <Button
                onClick={() => void confirm()}
                disabled={selected.size === 0 || props.applying || (newBase && !name.trim())}
              >
                {props.applying && <Spinner />}
                {newBase
                  ? `Create base with ${changeCount(selected.size)}`
                  : `Apply ${changeCount(selected.size)}`}
              </Button>
            </DialogFooter>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The base's assistant (creators, AI on): the top bar's "Assistant". */
export function BaseAssistantDialog({
  baseId,
  open,
  onOpenChange,
}: {
  baseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const plan = useAssistantPlan(baseId);
  const apply = useApplyAssistantPlan(baseId);
  return (
    <AssistantPanel
      open={open}
      onOpenChange={onOpenChange}
      newBase={false}
      plan={(prompt, includeRecords) => plan.mutateAsync({ prompt, includeRecords })}
      planning={plan.isPending}
      apply={(p) => apply.mutateAsync(p)}
      applying={apply.isPending}
      onApplied={(r) => {
        if (r.firstTableId) {
          void navigate({
            to: '/b/$baseId/$tableId',
            params: { baseId, tableId: r.firstTableId },
            search: {},
          });
        }
      }}
    />
  );
}

/** Home's "Describe it": a new base in the workspace from a description. */
export function DescribeBaseDialog({
  workspaceId,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const plan = useAssistantBasePlan(workspaceId);
  const apply = useApplyAssistantBasePlan(workspaceId);
  return (
    <AssistantPanel
      open={open}
      onOpenChange={onOpenChange}
      newBase
      plan={(prompt) => plan.mutateAsync(prompt)}
      planning={plan.isPending}
      apply={(p, name) => apply.mutateAsync({ name, plan: p })}
      applying={apply.isPending}
      onApplied={(r) => void navigate({ to: '/b/$baseId', params: { baseId: r.baseId } })}
    />
  );
}
