import {
  type Automation,
  type AutomationAction,
  type AutomationActionType,
  type AutomationScripts,
  type AutomationTrigger,
  type AutomationTriggerType,
  type FieldMeta,
  type FilterGroup,
  HTTP_METHODS,
  SCHEDULE_UNITS,
} from '@openrows/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { tableQueries, viewQueries } from '../../api/queries';
import { Button, Input, toast } from '../../components/ui';
import { cn } from '../../lib/utils';
import { FilterMenu, selectClass } from '../views/toolbar/FilterMenu';
import {
  ACTION_LABELS,
  ACTION_TYPES,
  defaultTrigger,
  pretty,
  type TokenOption,
  TRIGGER_LABELS,
  TRIGGER_TYPES,
  tomorrowAtNine,
  writableFields,
} from './model';
import { TokenInput, textareaClass } from './TokenInput';

type Table = { id: string; name: string };

const checkboxClass = 'size-4 shrink-0 accent-[var(--accent)]';
const emptyFilter: FilterGroup = { conjunction: 'and', conditions: [] };

/** The fields of a table (or none while it loads). */
export function useTableFields(tableId: string | null | undefined): FieldMeta[] | undefined {
  const q = useQuery({ ...tableQueries.detail(tableId ?? ''), enabled: !!tableId });
  return q.data?.fields;
}

/** A labelled control with its server error underneath. */
function Row({
  label,
  htmlFor,
  error,
  errorId,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string | undefined;
  errorId?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-small font-[550] text-text-2">
          {label}
        </label>
      ) : (
        <span className="text-small font-[550] text-text-2">{label}</span>
      )}
      {children}
      {hint && !error && <span className="text-small text-text-2">{hint}</span>}
      {error && (
        <span id={errorId} className="text-small text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

function Select<T extends string>({
  id,
  value,
  options,
  onChange,
  label,
  placeholder,
}: {
  id?: string;
  value: T | '';
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label?: string;
  placeholder?: string;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      className={cn(selectClass, 'h-8 w-full')}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A step of the canvas: "When" or "Then N", the editor, its server errors. */
export function StepCard({
  label,
  title,
  errors,
  actions,
  children,
}: {
  label: string;
  title: string;
  errors: string[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 shadow-1"
    >
      <header className="flex items-center gap-2">
        <span className="rounded-xs bg-header px-1.5 text-caps font-semibold tracking-[0.06em] text-text-2 uppercase">
          {label}
        </span>
        <h3 id={headingId} className="min-w-0 flex-1 truncate text-heading font-semibold">
          {title}
        </h3>
        {actions}
      </header>
      {children}
      {errors.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-small text-danger" aria-label="Problems">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- Trigger ----

export function TriggerEditor({
  automation,
  trigger,
  tables,
  errorAt,
  onChange,
  onRotateUrl,
}: {
  automation: Automation;
  trigger: AutomationTrigger;
  tables: readonly Table[];
  errorAt: (path: string) => string | undefined;
  onChange: (trigger: AutomationTrigger) => void;
  onRotateUrl: () => void;
}) {
  const typeId = useId();
  const tableId = useId();
  const firstTable = tables[0]?.id ?? '';
  const triggerTable = 'tableId' in trigger ? trigger.tableId : null;
  const fields = useTableFields(triggerTable);
  return (
    <div className="flex flex-col gap-3">
      <Row label="Trigger" htmlFor={typeId}>
        <Select<AutomationTriggerType>
          id={typeId}
          value={trigger.type}
          options={TRIGGER_TYPES.map((t) => ({ value: t, label: TRIGGER_LABELS[t] }))}
          onChange={(type) =>
            type !== trigger.type && onChange(defaultTrigger(type, triggerTable ?? firstTable))
          }
        />
      </Row>
      {'tableId' in trigger && (
        <Row label="Table" htmlFor={tableId} error={errorAt('trigger.tableId')}>
          <Select
            id={tableId}
            value={trigger.tableId}
            placeholder="Pick a table"
            options={tables.map((t) => ({ value: t.id, label: t.name }))}
            onChange={(id) => id !== trigger.tableId && onChange(defaultTrigger(trigger.type, id))}
          />
        </Row>
      )}
      {trigger.type === 'recordUpdated' && (
        <WatchedFields
          fields={fields ?? []}
          value={trigger.fieldIds}
          error={errorAt('trigger.fieldIds')}
          onChange={(fieldIds) => onChange({ ...trigger, fieldIds })}
        />
      )}
      {trigger.type === 'recordMatches' && (
        <Row label="Conditions">
          <ConditionsSummary
            fields={fields ?? []}
            filter={trigger.filter}
            onChange={(filter) => onChange({ ...trigger, filter })}
          />
        </Row>
      )}
      {trigger.type === 'formSubmitted' && (
        <FormViewPicker
          tableId={trigger.tableId}
          value={trigger.viewId}
          error={errorAt('trigger.viewId')}
          onChange={(viewId) => onChange({ ...trigger, viewId })}
        />
      )}
      {trigger.type === 'buttonClicked' && (
        <ButtonFieldPicker
          fields={fields ?? []}
          value={trigger.fieldId}
          error={errorAt('trigger.fieldId')}
          onChange={(fieldId) => onChange({ ...trigger, fieldId })}
        />
      )}
      {trigger.type === 'scheduled' && (
        <ScheduleEditor trigger={trigger} errorAt={errorAt} onChange={onChange} />
      )}
      {trigger.type === 'webhookReceived' && (
        <WebhookTrigger
          automation={automation}
          saved={automation.trigger.type === 'webhookReceived'}
          onRotate={onRotateUrl}
        />
      )}
    </div>
  );
}

function WatchedFields({
  fields,
  value,
  error,
  onChange,
}: {
  fields: readonly FieldMeta[];
  value: string[] | null;
  error: string | undefined;
  onChange: (fieldIds: string[] | null) => void;
}) {
  const ids = value ?? [];
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-small font-[550] text-text-2">Fields to watch</legend>
      <p className="text-small text-text-2">
        {ids.length ? 'Runs when one of these changes.' : 'Runs when any field changes.'}
      </p>
      <div className="grid max-h-40 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto">
        {fields.map((f) => (
          <label key={f.id} className="flex min-w-0 cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              className={checkboxClass}
              checked={ids.includes(f.id)}
              onChange={(e) => {
                const next = e.target.checked ? [...ids, f.id] : ids.filter((x) => x !== f.id);
                onChange(next.length ? next : null);
              }}
            />
            <span className="truncate">{f.name}</span>
          </label>
        ))}
      </div>
      {error && <span className="text-small text-danger">{error}</span>}
    </fieldset>
  );
}

/** The view filter builder, on a trigger's or a find step's conditions. */
function ConditionsSummary({
  fields,
  filter,
  onChange,
}: {
  fields: FieldMeta[];
  filter: FilterGroup | undefined;
  onChange: (filter: FilterGroup) => void;
}) {
  const group = filter ?? emptyFilter;
  const n = group.conditions.length;
  return (
    <div className="flex items-center gap-2">
      <FilterMenu fields={fields} filter={group} onChange={onChange} />
      <span className="text-small text-text-2">
        {n === 0 ? 'No conditions: every record' : `${n} condition${n === 1 ? '' : 's'}`}
      </span>
    </div>
  );
}

function FormViewPicker({
  tableId,
  value,
  error,
  onChange,
}: {
  tableId: string;
  value: string;
  error: string | undefined;
  onChange: (viewId: string) => void;
}) {
  const id = useId();
  const views = useQuery({ ...viewQueries.list(tableId), enabled: !!tableId });
  const forms = (views.data?.views ?? []).filter((v) => v.type === 'form');
  return (
    <Row
      label="Form"
      htmlFor={id}
      error={error}
      hint={forms.length ? undefined : 'This table has no form view yet: add one first.'}
    >
      <Select
        id={id}
        value={forms.some((f) => f.id === value) ? value : ''}
        placeholder="Pick a form"
        options={forms.map((v) => ({ value: v.id, label: v.name }))}
        onChange={onChange}
      />
    </Row>
  );
}

function ButtonFieldPicker({
  fields,
  value,
  error,
  onChange,
}: {
  fields: readonly FieldMeta[];
  value: string;
  error: string | undefined;
  onChange: (fieldId: string) => void;
}) {
  const id = useId();
  const buttons = fields.filter((f) => f.type === 'button');
  return (
    <Row
      label="Button field"
      htmlFor={id}
      error={error}
      hint='Set the button to "Run automations" in its field settings.'
    >
      <Select
        id={id}
        value={buttons.some((f) => f.id === value) ? value : ''}
        placeholder={buttons.length ? 'Pick a button field' : 'This table has no button field'}
        options={buttons.map((f) => ({ value: f.id, label: f.name }))}
        onChange={onChange}
      />
    </Row>
  );
}

function ScheduleEditor({
  trigger,
  errorAt,
  onChange,
}: {
  trigger: AutomationTrigger & { type: 'scheduled' };
  errorAt: (path: string) => string | undefined;
  onChange: (trigger: AutomationTrigger) => void;
}) {
  const ids = { kind: useId(), every: useId(), unit: useId(), start: useId(), zone: useId() };
  const s = trigger.schedule;
  const set = (schedule: typeof s) => onChange({ ...trigger, schedule });
  const zoneError = errorAt('trigger.schedule.timeZone');
  return (
    <div className="flex flex-col gap-3">
      <Row label="Repeat" htmlFor={ids.kind}>
        <Select<'interval' | 'cron'>
          id={ids.kind}
          value={s.kind}
          options={[
            { value: 'interval', label: 'Every…' },
            { value: 'cron', label: 'Cron expression' },
          ]}
          onChange={(kind) =>
            kind !== s.kind &&
            set(
              kind === 'cron'
                ? { kind, expression: '0 9 * * 1-5', timeZone: s.timeZone }
                : {
                    kind,
                    every: 1,
                    unit: 'days',
                    startAt: tomorrowAtNine(),
                    timeZone: s.timeZone,
                  }
            )
          }
        />
      </Row>
      {s.kind === 'interval' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Every" htmlFor={ids.every} error={errorAt('trigger.schedule.every')}>
              <Input
                id={ids.every}
                type="number"
                min={1}
                value={s.every}
                onChange={(e) => set({ ...s, every: Number(e.target.value) || 1 })}
              />
            </Row>
            <Row label="Unit" htmlFor={ids.unit}>
              <Select
                id={ids.unit}
                value={s.unit}
                options={SCHEDULE_UNITS.map((u) => ({ value: u, label: u }))}
                onChange={(unit) => set({ ...s, unit })}
              />
            </Row>
          </div>
          <Row label="Starting" htmlFor={ids.start} error={errorAt('trigger.schedule.startAt')}>
            <Input
              id={ids.start}
              type="datetime-local"
              value={s.startAt}
              onChange={(e) => set({ ...s, startAt: e.target.value.slice(0, 16) })}
            />
          </Row>
        </>
      ) : (
        <Row
          label="Cron expression"
          htmlFor={ids.every}
          error={errorAt('trigger.schedule.expression')}
          hint="minute hour day month weekday, e.g. 0 9 * * 1-5 (weekdays at 09:00)"
        >
          <Input
            id={ids.every}
            className="font-mono"
            value={s.expression}
            onChange={(e) => set({ ...s, expression: e.target.value })}
          />
        </Row>
      )}
      <Row label="Time zone" htmlFor={ids.zone} error={zoneError}>
        <Input
          id={ids.zone}
          value={s.timeZone}
          onChange={(e) => set({ ...s, timeZone: e.target.value })}
        />
      </Row>
    </div>
  );
}

function WebhookTrigger({
  automation,
  saved,
  onRotate,
}: {
  automation: Automation;
  saved: boolean;
  onRotate: () => void;
}) {
  const urlId = useId();
  const url = saved ? automation.webhookUrl : null;
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Webhook URL copied');
    } catch {
      toast.error("Couldn't copy. Select the URL and copy it.");
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <Row
        label="Webhook URL"
        htmlFor={urlId}
        hint="POST JSON (up to 100 KB) to this URL. Anyone with it can trigger the automation."
      >
        {url ? (
          <div className="flex items-center gap-1">
            <Input
              id={urlId}
              readOnly
              value={url}
              className="font-mono text-small"
              onFocus={(e) => e.target.select()}
            />
            <Button type="button" variant="secondary" size="sm" onClick={copy}>
              <CopyIcon />
              Copy
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onRotate}
              aria-label="Make a new webhook URL"
            >
              <RefreshCwIcon />
              New URL
            </Button>
          </div>
        ) : (
          <p id={urlId} className="text-text-2">
            Save to get the URL.
          </p>
        )}
      </Row>
      <div className="flex flex-col gap-1">
        <span className="text-small font-[550] text-text-2">Last request received</span>
        {automation.webhookSample ? (
          <pre
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable
            tabIndex={0}
            className="max-h-40 overflow-auto rounded-sm bg-header p-2 font-mono text-small whitespace-pre-wrap break-all"
          >
            {pretty(automation.webhookSample.body)}
          </pre>
        ) : (
          <p className="text-text-2">
            None yet. Send a request to the URL: its body gives the values steps can use and the
            data a test runs with.
          </p>
        )}
      </div>
    </div>
  );
}

// ---- Actions ----

export function ActionCard({
  index,
  count,
  action,
  tables,
  tokens,
  errors,
  errorAt,
  onChange,
  onMove,
  onDelete,
  scripts,
}: {
  index: number;
  count: number;
  action: AutomationAction;
  tables: readonly Table[];
  tokens: readonly TokenOption[];
  /** Whether this workspace may run scripts. */
  scripts?: AutomationScripts | undefined;
  errors: string[];
  errorAt: (path: string) => string | undefined;
  onChange: (action: AutomationAction) => void;
  onMove: (to: number) => void;
  onDelete: () => void;
}) {
  const n = index + 1;
  const title = ACTION_LABELS[action.type];
  const at = (rest: string) => errorAt(`actions.${index}${rest ? `.${rest}` : ''}`);
  return (
    <StepCard
      label={`Then ${n}`}
      title={title}
      errors={errors}
      actions={
        <div className="flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
            aria-label={`Move step ${n} up`}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
            aria-label={`Move step ${n} down`}
          >
            <ArrowDownIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onDelete}
            aria-label={`Delete step ${n}`}
          >
            <Trash2Icon />
          </Button>
        </div>
      }
    >
      <ActionFields
        action={action}
        index={index}
        tables={tables}
        tokens={tokens}
        at={at}
        onChange={onChange}
        scripts={scripts}
      />
    </StepCard>
  );
}

function TableSelect({
  value,
  tables,
  error,
  onChange,
}: {
  value: string;
  tables: readonly Table[];
  error: string | undefined;
  onChange: (tableId: string) => void;
}) {
  const id = useId();
  return (
    <Row label="Table" htmlFor={id} error={error}>
      <Select
        id={id}
        value={tables.some((t) => t.id === value) ? value : ''}
        placeholder="Pick a table"
        options={tables.map((t) => ({ value: t.id, label: t.name }))}
        onChange={onChange}
      />
    </Row>
  );
}

function ActionFields({
  action,
  index,
  tables,
  tokens,
  at,
  onChange,
  scripts,
}: {
  action: AutomationAction;
  index: number;
  tables: readonly Table[];
  tokens: readonly TokenOption[];
  at: (rest: string) => string | undefined;
  onChange: (action: AutomationAction) => void;
  scripts?: AutomationScripts | undefined;
}) {
  const ids = { a: useId(), b: useId(), c: useId(), d: useId() };
  const fields = useTableFields('tableId' in action ? action.tableId : null);
  const n = index + 1;
  switch (action.type) {
    case 'createRecord':
    case 'updateRecord':
      return (
        <>
          <TableSelect
            value={action.tableId}
            tables={tables}
            error={at('tableId')}
            onChange={(tableId) => onChange({ ...action, tableId, fields: {} })}
          />
          {action.type === 'updateRecord' && (
            <Row
              label="Record ID"
              htmlFor={ids.a}
              error={at('recordId')}
              hint="A record's ID, or a value such as the trigger's record or a found list."
            >
              <TokenInput
                id={ids.a}
                label={`step ${n}'s record ID`}
                value={action.recordId}
                tokens={tokens}
                invalid={!!at('recordId')}
                onChange={(recordId) => onChange({ ...action, recordId })}
              />
            </Row>
          )}
          <FieldValues
            step={n}
            fields={writableFields(fields ?? [])}
            value={action.fields}
            tokens={tokens}
            errorFor={(fieldId) => at(`fields.${fieldId}`)}
            onChange={(cells) => onChange({ ...action, fields: cells })}
          />
          {at('fields') && <span className="text-small text-danger">{at('fields')}</span>}
        </>
      );
    case 'findRecords':
      return (
        <>
          <TableSelect
            value={action.tableId}
            tables={tables}
            error={at('tableId')}
            onChange={(tableId) => onChange({ ...action, tableId, filter: emptyFilter })}
          />
          <Row
            label="Conditions"
            hint="Text values may hold values from the trigger, e.g. {{trigger.record.id}}."
          >
            <ConditionsSummary
              fields={fields ?? []}
              filter={action.filter}
              onChange={(filter) => onChange({ ...action, filter })}
            />
          </Row>
          <Row label="At most" htmlFor={ids.b} error={at('limit')}>
            <Input
              id={ids.b}
              type="number"
              min={1}
              max={100}
              className="w-24"
              value={action.limit}
              onChange={(e) =>
                onChange({ ...action, limit: Math.min(100, Math.max(1, Number(e.target.value))) })
              }
            />
          </Row>
        </>
      );
    case 'sendEmail':
      return (
        <>
          <Row
            label="To"
            htmlFor={ids.a}
            error={at('to')}
            hint="Addresses or values (a user field, an email field), separated by commas."
          >
            <TokenInput
              id={ids.a}
              label={`step ${n}'s recipients`}
              value={action.to.join(', ')}
              tokens={tokens}
              invalid={!!at('to')}
              onChange={(v) =>
                onChange({
                  ...action,
                  to: v
                    .split(/[,;\n]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Row>
          <Row label="Subject" htmlFor={ids.b} error={at('subject')}>
            <TokenInput
              id={ids.b}
              label={`step ${n}'s subject`}
              value={action.subject}
              tokens={tokens}
              invalid={!!at('subject')}
              onChange={(subject) => onChange({ ...action, subject })}
            />
          </Row>
          <Row label="Message (Markdown)" htmlFor={ids.c} error={at('body')}>
            <TokenInput
              id={ids.c}
              multiline
              label={`step ${n}'s message`}
              value={action.body}
              tokens={tokens}
              onChange={(body) => onChange({ ...action, body })}
            />
          </Row>
        </>
      );
    case 'slackMessage':
      return (
        <>
          <Row
            label="Slack incoming webhook URL"
            htmlFor={ids.a}
            error={at('webhookUrl')}
            hint="Stored encrypted and never shown again. Leave empty to keep the saved one."
          >
            <Input
              id={ids.a}
              type="url"
              placeholder="https://hooks.slack.com/services/…"
              value={action.webhookUrl ?? ''}
              aria-invalid={!!at('webhookUrl') || undefined}
              onChange={(e) => {
                const { webhookUrl: _old, ...rest } = action;
                onChange(e.target.value ? { ...rest, webhookUrl: e.target.value } : rest);
              }}
            />
          </Row>
          <Row label="Message" htmlFor={ids.b} error={at('text')}>
            <TokenInput
              id={ids.b}
              multiline
              label={`step ${n}'s message`}
              value={action.text}
              tokens={tokens}
              invalid={!!at('text')}
              onChange={(text) => onChange({ ...action, text })}
            />
          </Row>
        </>
      );
    case 'httpRequest':
      return <HttpFields action={action} n={n} tokens={tokens} at={at} onChange={onChange} />;
    case 'runScript':
      return (
        <ScriptFields
          action={action}
          tokens={tokens}
          at={at}
          onChange={onChange}
          scripts={scripts}
        />
      );
  }
}

/** Why scripts can't run here, or their limits. */
export function scriptsNote(scripts: AutomationScripts | undefined): string {
  if (!scripts) return '';
  if (scripts.available && scripts.limits) {
    const { timeoutSeconds, cpuSeconds, memoryMb } = scripts.limits;
    return `Runs in a sandbox with no network: up to ${timeoutSeconds} s, ${cpuSeconds} s of CPU and ${memoryMb} MB of memory.`;
  }
  return scripts.reason === 'plan'
    ? "Scripts aren't part of this workspace's plan."
    : "This server doesn't run scripts. Its administrator can turn them on (AUTOMATION_SCRIPTS).";
}

function ScriptInputRow({
  i,
  name,
  value,
  tokens,
  invalid,
  onChange,
  onRemove,
}: {
  i: number;
  name: string;
  value: string;
  tokens: readonly TokenOption[];
  invalid: boolean;
  onChange: (entry: [string, string]) => void;
  onRemove: () => void;
}) {
  const valueId = useId();
  return (
    <div className="flex items-center gap-1.5">
      <Input
        aria-label={`Input ${i + 1} name`}
        className="w-40 shrink-0 font-mono text-small"
        value={name}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange([e.target.value, value])}
      />
      <label htmlFor={valueId} className="sr-only">
        Input {i + 1} value
      </label>
      <div className="min-w-0 flex-1">
        <TokenInput
          id={valueId}
          label={`input ${i + 1}'s value`}
          value={value}
          tokens={tokens}
          onChange={(v) => onChange([name, v])}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove input ${i + 1}`}
        onClick={onRemove}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

/** A run-script step: input variables (with tokens) and the script. */
function ScriptFields({
  action,
  tokens,
  at,
  onChange,
  scripts,
}: {
  action: AutomationAction & { type: 'runScript' };
  tokens: readonly TokenOption[];
  at: (rest: string) => string | undefined;
  onChange: (action: AutomationAction) => void;
  scripts: AutomationScripts | undefined;
}) {
  const scriptId = useId();
  const helpId = useId();
  const entries = Object.entries(action.inputs);
  const setEntries = (next: [string, string][]) =>
    onChange({ ...action, inputs: Object.fromEntries(next) });
  const unavailable = scripts !== undefined && !scripts.available;
  return (
    <>
      {scripts && (
        <p
          role="note"
          className={cn(
            'rounded-md border border-border px-3 py-2 text-small',
            unavailable ? 'bg-hover text-text' : 'text-text-2'
          )}
        >
          {scriptsNote(scripts)}
        </p>
      )}
      {at('type') && <span className="text-small text-danger">{at('type')}</span>}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-small font-[550] text-text-2">
          Input variables (input.config())
        </legend>
        {entries.map(([name, value], i) => (
          <ScriptInputRow
            // biome-ignore lint/suspicious/noArrayIndexKey: inputs are edited by position
            key={i}
            i={i}
            name={name}
            value={value}
            tokens={tokens}
            invalid={!!at(`inputs.${name}`)}
            onChange={(next) => setEntries(entries.map((x, j) => (j === i ? next : x)))}
            onRemove={() => setEntries(entries.filter((_, j) => j !== i))}
          />
        ))}
        {at('inputs') && <span className="text-small text-danger">{at('inputs')}</span>}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              let k = entries.length + 1;
              while (`input${k}` in action.inputs) k += 1;
              setEntries([...entries, [`input${k}`, '']]);
            }}
          >
            <PlusIcon /> Add input
          </Button>
        </div>
      </fieldset>
      <Row
        label="Script (JavaScript)"
        htmlFor={scriptId}
        error={at('script')}
        hint={
          <span id={helpId}>
            <code>base.getTable(name)</code>: <code>selectRecordsAsync</code>,{' '}
            <code>selectRecordAsync</code>, <code>createRecordAsync</code>,{' '}
            <code>updateRecordAsync</code>, <code>deleteRecordAsync</code>; <code>fetch</code>{' '}
            (through the server); <code>output.set(name, value)</code>. It runs as the person the
            automation runs as.
          </span>
        }
      >
        <textarea
          id={scriptId}
          aria-describedby={helpId}
          spellCheck={false}
          rows={14}
          className={cn(textareaClass, 'font-mono text-small leading-5')}
          value={action.script}
          aria-invalid={!!at('script') || undefined}
          onChange={(e) => onChange({ ...action, script: e.target.value })}
          onKeyDown={(e) => {
            // Tab indents in the script instead of leaving it (Esc then Tab leaves).
            if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            const next = `${action.script.slice(0, a)}  ${action.script.slice(b)}`;
            onChange({ ...action, script: next });
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
          }}
        />
      </Row>
    </>
  );
}

function HttpFields({
  action,
  n,
  tokens,
  at,
  onChange,
}: {
  action: AutomationAction & { type: 'httpRequest' };
  n: number;
  tokens: readonly TokenOption[];
  at: (rest: string) => string | undefined;
  onChange: (action: AutomationAction) => void;
}) {
  const ids = { method: useId(), url: useId(), body: useId() };
  const [bodyText, setBodyText] = useState(() =>
    action.body === undefined ? '' : JSON.stringify(action.body, null, 2)
  );
  const [bodyError, setBodyError] = useState<string | null>(null);
  const setHeader = (i: number, patch: Partial<(typeof action.headers)[number]>) =>
    onChange({
      ...action,
      headers: action.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)),
    });
  return (
    <>
      <div className="grid grid-cols-[110px_1fr] gap-2">
        <Row label="Method" htmlFor={ids.method}>
          <Select
            id={ids.method}
            value={action.method}
            options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
            onChange={(method) => onChange({ ...action, method })}
          />
        </Row>
        <Row label="URL" htmlFor={ids.url} error={at('url')}>
          <TokenInput
            id={ids.url}
            label={`step ${n}'s URL`}
            value={action.url}
            tokens={tokens}
            invalid={!!at('url')}
            placeholder="https://example.com/hook"
            onChange={(url) => onChange({ ...action, url })}
          />
        </Row>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-small font-[550] text-text-2">Headers</legend>
        {action.headers.map((h, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: headers have no id
          <div key={i} className="flex items-center gap-1.5">
            <Input
              aria-label={`Header ${i + 1} name`}
              className="w-40 font-mono text-small"
              value={h.name}
              onChange={(e) => setHeader(i, { name: e.target.value })}
            />
            <Input
              aria-label={`Header ${i + 1} value`}
              className="font-mono text-small"
              placeholder={h.secret && h.value === undefined ? 'Saved (hidden)' : ''}
              value={h.value ?? ''}
              onChange={(e) => setHeader(i, { value: e.target.value })}
            />
            <label className="flex shrink-0 items-center gap-1 text-small">
              <input
                type="checkbox"
                className={checkboxClass}
                checked={h.secret ?? false}
                onChange={(e) => setHeader(i, { secret: e.target.checked })}
              />
              Secret
            </label>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove header ${i + 1}`}
              onClick={() =>
                onChange({ ...action, headers: action.headers.filter((_, j) => j !== i) })
              }
            >
              <XIcon />
            </Button>
          </div>
        ))}
        {at('headers') && <span className="text-small text-danger">{at('headers')}</span>}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange({
                ...action,
                headers: [...action.headers, { name: '', value: '', secret: false }],
              })
            }
          >
            <PlusIcon />
            Add header
          </Button>
        </div>
      </fieldset>
      {action.method !== 'GET' && (
        <Row label="JSON body" htmlFor={ids.body} error={bodyError ?? at('body')}>
          <textarea
            id={ids.body}
            rows={5}
            className={cn(textareaClass, 'font-mono text-small', bodyError && 'border-danger')}
            placeholder='{ "name": "{{trigger.record.fields.Name}}" }'
            value={bodyText}
            onChange={(e) => {
              setBodyText(e.target.value);
              if (!e.target.value.trim()) {
                setBodyError(null);
                const { body: _b, ...rest } = action;
                onChange(rest);
                return;
              }
              try {
                const body: unknown = JSON.parse(e.target.value);
                setBodyError(null);
                onChange({ ...action, body });
              } catch {
                setBodyError('Not valid JSON yet.');
              }
            }}
          />
        </Row>
      )}
    </>
  );
}

/** The cells a create or update step writes: a value (or token) per field. */
function FieldValues({
  step,
  fields,
  value,
  tokens,
  errorFor,
  onChange,
}: {
  step: number;
  fields: readonly FieldMeta[];
  value: Record<string, unknown>;
  tokens: readonly TokenOption[];
  errorFor: (fieldId: string) => string | undefined;
  onChange: (cells: Record<string, unknown>) => void;
}) {
  const addId = useId();
  const used = Object.keys(value);
  const unused = fields.filter((f) => !used.includes(f.id));
  const nameOf = (id: string) => fields.find((f) => f.id === id)?.name ?? 'Unknown field';
  const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-small font-[550] text-text-2">Fields</legend>
      {used.length === 0 && <p className="text-small text-text-2">No fields set yet.</p>}
      {used.map((fieldId) => {
        const inputId = `${addId}-${fieldId}`;
        const error = errorFor(fieldId);
        return (
          <div key={fieldId} className="grid grid-cols-[140px_1fr_auto] items-start gap-2">
            <label htmlFor={inputId} className="truncate pt-1.5 text-body">
              {nameOf(fieldId)}
            </label>
            <div className="flex flex-col gap-0.5">
              <TokenInput
                id={inputId}
                label={`${nameOf(fieldId)} in step ${step}`}
                value={text(value[fieldId])}
                tokens={tokens}
                invalid={!!error}
                onChange={(v) => onChange({ ...value, [fieldId]: v })}
              />
              {error && <span className="text-small text-danger">{error}</span>}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Stop setting ${nameOf(fieldId)}`}
              onClick={() => {
                const { [fieldId]: _gone, ...rest } = value;
                onChange(rest);
              }}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
      {unused.length > 0 && (
        <select
          id={addId}
          aria-label={`Add a field to step ${step}`}
          className={cn(selectClass, 'h-8 w-56')}
          value=""
          onChange={(e) => e.target.value && onChange({ ...value, [e.target.value]: '' })}
        >
          <option value="">+ Add a field…</option>
          {unused.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
    </fieldset>
  );
}

/** "Add action": the action type picker under the last step. */
export function AddAction({
  disabled,
  onAdd,
  scripts,
}: {
  disabled: boolean;
  onAdd: (type: AutomationActionType) => void;
  scripts?: AutomationScripts | undefined;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <PlusIcon className="size-4 text-text-2" aria-hidden />
      <label htmlFor={id} className="sr-only">
        Add an action
      </label>
      <select
        id={id}
        disabled={disabled}
        className={cn(selectClass, 'h-8 w-60')}
        value=""
        onChange={(e) => e.target.value && onAdd(e.target.value as AutomationActionType)}
      >
        <option value="">Add an action…</option>
        {ACTION_TYPES.map((t) => {
          const off = t === 'runScript' && scripts !== undefined && !scripts.available;
          return (
            <option key={t} value={t} disabled={off}>
              {ACTION_LABELS[t]}
              {off ? ' (not available)' : ''}
            </option>
          );
        })}
      </select>
    </div>
  );
}
