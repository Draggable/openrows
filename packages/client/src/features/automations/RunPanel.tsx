import {
  AUTOMATION_RUN_STATUSES,
  type Automation,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationTrigger,
} from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangleIcon,
  CheckIcon,
  FlaskConicalIcon,
  MinusIcon,
  RotateCcwIcon,
  XIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import {
  recordQueries,
  useAutomationRuns,
  useFailedAutomationRuns,
  useRetryAutomationRun,
} from '../../api/queries';
import { Button, Skeleton, toast } from '../../components/ui';
import { cn } from '../../lib/utils';
import { selectClass } from '../views/toolbar/FilterMenu';
import {
  ACTION_LABELS,
  canRetry,
  modeLabel,
  needsRecord,
  pretty,
  problemErrors,
  RUN_STATUS_LABELS,
  runSubject,
  runWhen,
  SKIP_REASON_LABELS,
  triggerTableId,
} from './model';
import { useTableFields } from './steps';

export function StatusIcon({ status }: { status: AutomationRunStatus }) {
  const label = RUN_STATUS_LABELS[status];
  if (status === 'succeeded')
    return <CheckIcon className="size-4 shrink-0 text-primary" aria-label={label} role="img" />;
  if (status === 'failed')
    return <XIcon className="size-4 shrink-0 text-danger" aria-label={label} role="img" />;
  return <MinusIcon className="size-4 shrink-0 text-text-2" aria-label={label} role="img" />;
}

function Json({ value, label }: { value: unknown; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-small text-text-2">{label}</span>
      {/* Focusable, so its scrolled content is reachable from the keyboard. */}
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable
        tabIndex={0}
        className="max-h-48 overflow-auto rounded-sm bg-header p-2 font-mono text-small whitespace-pre-wrap break-all"
      >
        {pretty(value)}
      </pre>
    </div>
  );
}

/** A run's error, trigger data and each step with its (redacted) input and output. */
export function RunDetails({ run }: { run: AutomationRun }) {
  return (
    <div className="flex flex-col gap-2">
      {run.error && (
        <p className="text-small text-danger" role="note">
          {run.error}
        </p>
      )}
      <Json label="Trigger" value={run.trigger} />
      {run.steps.length > 0 && (
        <ol aria-label="Steps" className="flex flex-col gap-2">
          {run.steps.map((step) => (
            <li
              key={step.index}
              className="flex flex-col gap-1 rounded-sm border border-border p-2"
            >
              <div className="flex items-center gap-2">
                <StatusIcon status={step.status} />
                <span className="min-w-0 flex-1 truncate font-[550]">
                  Step {step.index}: {ACTION_LABELS[step.type]}
                </span>
                <span className="text-small text-text-2">
                  {RUN_STATUS_LABELS[step.status]} · {step.durationMs} ms
                </span>
              </div>
              {step.error && <p className="text-small text-danger">{step.error}</p>}
              {step.status !== 'skipped' && (
                <>
                  <Json label="Input" value={step.input} />
                  {step.output !== null && <Json label="Output" value={step.output} />}
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** A record of the trigger's table to test with: the first 100, by their first field. */
function SampleRecordPicker({
  tableId,
  value,
  onChange,
}: {
  tableId: string;
  value: string;
  onChange: (recordId: string) => void;
}) {
  const id = useId();
  const records = useQuery({ ...recordQueries.list(tableId, { limit: 100 }), enabled: !!tableId });
  const fields = useTableFields(tableId);
  const primary = fields?.find((f) => f.isPrimary) ?? fields?.[0];
  const label = (r: { id: string; fields: Record<string, unknown> }) => {
    const v = primary ? r.fields[primary.id] : null;
    return typeof v === 'string' && v.trim()
      ? v
      : typeof v === 'number'
        ? String(v)
        : `Record ${r.id.slice(0, 8)}`;
  };
  const list = records.data?.records ?? [];
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-small font-[550] text-text-2">
        Test with record
      </label>
      <select
        id={id}
        className={cn(selectClass, 'h-8 w-full')}
        value={list.some((r) => r.id === value) ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          {records.isPending ? 'Loading records…' : list.length ? 'Pick a record' : 'No records'}
        </option>
        {list.map((r) => (
          <option key={r.id} value={r.id}>
            {label(r)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Test (as in Airtable): the trigger fires with a sample record (or the last webhook
 * request, or now) and the actions run for real, as you; the result shows each step.
 */
export function TestPanel({
  automation,
  trigger,
  dirty,
  running,
  result,
  onTest,
}: {
  automation: Automation;
  trigger: AutomationTrigger;
  dirty: boolean;
  running: boolean;
  result: AutomationRun | null;
  onTest: (recordId: string | undefined) => void;
}) {
  const [recordId, setRecordId] = useState('');
  const tableId = triggerTableId(trigger);
  const recordNeeded = needsRecord(trigger);
  const webhookWithoutSample =
    trigger.type === 'webhookReceived' && !automation.webhookSample && !dirty;
  const noActions = automation.actions.length === 0 && !dirty;
  return (
    <div className="flex flex-col gap-3">
      <div
        role="note"
        className="flex gap-2 rounded-sm border border-border border-t-2 border-t-warning bg-surface p-3"
      >
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <p className="text-small">
          A test runs the actions for real, as you: records are created and changed, and emails,
          messages and requests are sent.
        </p>
      </div>
      {recordNeeded && tableId && (
        <SampleRecordPicker tableId={tableId} value={recordId} onChange={setRecordId} />
      )}
      {trigger.type === 'webhookReceived' && (
        <p className="text-small text-text-2">
          {automation.webhookSample
            ? `Uses the last request, received ${runWhen(automation.webhookSample.receivedAt)}.`
            : 'Send a request to the webhook URL first: a test uses the last one received.'}
        </p>
      )}
      {trigger.type === 'scheduled' && (
        <p className="text-small text-text-2">Runs the actions as if the schedule fired now.</p>
      )}
      {noActions && <p className="text-small text-text-2">Add an action to test.</p>}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={() => onTest(recordNeeded ? recordId : undefined)}
          disabled={running || noActions || webhookWithoutSample || (recordNeeded && !recordId)}
        >
          <FlaskConicalIcon />
          {running ? 'Testing…' : dirty ? 'Save and test' : 'Run test'}
        </Button>
      </div>
      {result && (
        <section aria-label="Test result" className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <StatusIcon status={result.status} />
            <span className="font-[550]">
              Test {RUN_STATUS_LABELS[result.status].toLowerCase()}
            </span>
            <span className="text-small text-text-2">{result.durationMs} ms</span>
          </div>
          <RunDetails run={result} />
        </section>
      )}
    </div>
  );
}

/** The run history: the last 30 days, filtered by outcome; failed runs can be retried. */
export function RunHistory({ automation }: { automation: Automation }) {
  const filterId = useId();
  const [status, setStatus] = useState<AutomationRunStatus | ''>('');
  const runs = useAutomationRuns(automation.baseId, automation.id, status || undefined);
  const retry = useRetryAutomationRun(automation.baseId);
  const list = runs.data?.runs ?? [];
  const onRetry = (run: AutomationRun) =>
    retry.mutate(
      { automationId: automation.id, runId: run.id },
      {
        onSuccess: (r) =>
          r.status === 'succeeded'
            ? toast.success('Retry succeeded')
            : toast.error(`Retry ${RUN_STATUS_LABELS[r.status].toLowerCase()}`),
        onError: (err) => toast.error(problemErrors(err, "Couldn't retry the run").message),
      }
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <label htmlFor={filterId} className="text-small font-[550] text-text-2">
          Show
        </label>
        <select
          id={filterId}
          className={cn(selectClass, 'h-8')}
          value={status}
          onChange={(e) => setStatus(e.target.value as AutomationRunStatus | '')}
        >
          <option value="">All runs</option>
          {AUTOMATION_RUN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {RUN_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      {runs.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : runs.isError ? (
        <p className="py-4 text-center text-text-2">
          {problemErrors(runs.error, "Couldn't load the runs.").message}
        </p>
      ) : list.length === 0 ? (
        <p className="py-4 text-center text-text-2">
          {status
            ? `No ${RUN_STATUS_LABELS[status].toLowerCase()} runs in the last 30 days.`
            : 'No runs yet. Turn the automation on, or run a test.'}
        </p>
      ) : (
        <ul aria-label="Runs" className="flex flex-col divide-y divide-border">
          {list.map((run) => {
            const mode = modeLabel(run);
            return (
              <li key={run.id} className="py-1.5">
                <details>
                  <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 hover:bg-hover">
                    <StatusIcon status={run.status} />
                    <span className="min-w-0 flex-1 truncate">{runSubject(run)}</span>
                    {mode && (
                      <span className="rounded-full bg-header px-2 text-small text-text-2">
                        {mode}
                      </span>
                    )}
                    {run.skipReason && (
                      <span className="rounded-full bg-header px-2 text-small text-text-2">
                        {SKIP_REASON_LABELS[run.skipReason]}
                      </span>
                    )}
                    <span className="shrink-0 text-small text-text-2">
                      {runWhen(run.createdAt)}
                    </span>
                  </summary>
                  <div className="mt-2 flex flex-col gap-2 pl-6">
                    <RunDetails run={run} />
                    {canRetry(run, list) && (
                      <div>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={retry.isPending}
                          onClick={() => onRetry(run)}
                        >
                          <RotateCcwIcon />
                          Retry
                        </Button>
                      </div>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The failed runs of every automation of the base (the dead-letter view): failed live
 * runs and retries of the last 30 days nobody retried yet, to look into and retry in one place.
 * Shows nothing when there are none.
 */
export function FailedRuns({ baseId }: { baseId: string }) {
  const failed = useFailedAutomationRuns(baseId);
  const retry = useRetryAutomationRun(baseId);
  const runs = failed.data?.runs ?? [];
  if (!runs.length) return null;
  const onRetry = (run: AutomationRun) =>
    retry.mutate(
      { automationId: run.automationId, runId: run.id },
      {
        onSuccess: (r) =>
          r.status === 'succeeded'
            ? toast.success('Retry succeeded')
            : toast.error(`Retry ${RUN_STATUS_LABELS[r.status].toLowerCase()}`),
        onError: (err) => toast.error(problemErrors(err, "Couldn't retry the run").message),
      }
    );
  return (
    <section aria-labelledby="failed-runs" className="flex flex-col gap-2">
      <div>
        <h3 id="failed-runs" className="font-semibold">
          Failed runs ({runs.length})
        </h3>
        <p className="text-small text-text-2">
          Runs of the last 30 days that failed and weren't retried. Fix the cause, then retry them
          here.
        </p>
      </div>
      <ul
        aria-label="Failed runs"
        className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface px-3"
      >
        {runs.map((run) => (
          <li key={run.id} className="py-1.5">
            <details>
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-sm py-1 hover:bg-hover">
                <StatusIcon status={run.status} />
                <span className="w-40 shrink-0 truncate font-[550]">{run.automationName}</span>
                <span className="min-w-0 flex-1 truncate text-text-2">
                  {run.error ?? runSubject(run)}
                </span>
                <span className="shrink-0 text-small text-text-2">{runWhen(run.createdAt)}</span>
              </summary>
              <div className="mt-2 flex flex-col gap-2 pl-6">
                <RunDetails run={run} />
                <div className="flex gap-2">
                  {canRetry(run, []) && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={retry.isPending}
                      onClick={() => onRetry(run)}
                    >
                      <RotateCcwIcon />
                      Retry
                    </Button>
                  )}
                  <Button asChild variant="ghost" size="sm">
                    <Link
                      to="/b/$baseId/automations"
                      params={{ baseId }}
                      search={{ a: run.automationId }}
                    >
                      Open {run.automationName}
                    </Link>
                  </Button>
                </div>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
