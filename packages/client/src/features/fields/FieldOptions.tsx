import {
  AI_FIELD_OUTPUT_LABELS,
  AI_FIELD_OUTPUTS,
  AI_PROMPT_MAX,
  BUTTON_ACTIONS,
  type ButtonAction,
  CHOICE_COLORS,
  type Choice,
  DATE_FORMATS,
  DURATION_FORMATS,
  FIELD_ICONS,
  type FieldMeta,
  type FieldTypeName,
  getFieldType,
  ROLLUP_FUNCTIONS,
  TIME_FORMATS,
} from '@openrows/shared';
import { lazy, type ReactNode, Suspense, useId, useRef } from 'react';
import { useTable, useTables, useViews } from '../../api/queries';
import { ChoiceEditor } from './ChoiceEditor';
import { analyzeFormula, formulaFields } from './formula-editor/model';
import { defaultOptions, ROLLUP_LABELS, ROUNDED_ROLLUPS } from './model';

// CodeMirror and the formula evaluator load with the first formula field edited.
const FormulaEditor = lazy(() => import('./formula-editor/FormulaEditor'));

// The type's options, driven by the keys of its `optionsSchema` (never by the type name): one
// control per option key the registry's types use. A key without a control here keeps its
// value and default.

const DATE_FORMAT_LABELS: Record<(typeof DATE_FORMATS)[number], string> = {
  local: 'Local (10/25/2026 in en-US)',
  friendly: 'Friendly (October 25, 2026)',
  us: 'US (10/25/2026)',
  european: 'European (25/10/2026)',
  iso: 'ISO (2026-10-25)',
};

const TIME_FORMAT_LABELS: Record<(typeof TIME_FORMATS)[number], string> = {
  '12h': '12 hour (2:30 PM)',
  '24h': '24 hour (14:30)',
};

const ICON_LABELS: Record<(typeof FIELD_ICONS)[number], string> = {
  check: 'Check',
  star: 'Star',
  heart: 'Heart',
  thumbsUp: 'Thumbs up',
  flag: 'Flag',
  dot: 'Dot',
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function timeZones(): string[] {
  try {
    return ['UTC', ...Intl.supportedValuesOf('timeZone').filter((z) => z !== 'UTC')];
  } catch {
    return ['UTC'];
  }
}

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

/** A label and its control; `children` gets the id the label points at. */
function Row({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="grid grid-cols-[1fr_1.3fr] items-center gap-3 text-text">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

function Select<T extends string | number>({
  label,
  value,
  values,
  text,
  onChange,
}: {
  label: string;
  value: T;
  values: readonly T[];
  text: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <Row label={label}>
      {(id) => (
        <select
          id={id}
          value={String(value)}
          onChange={(e) => {
            const picked = values.find((v) => String(v) === e.target.value);
            if (picked !== undefined) onChange(picked);
          }}
          className={selectClass}
        >
          {values.map((v) => (
            <option key={String(v)} value={String(v)}>
              {text(v)}
            </option>
          ))}
        </select>
      )}
    </Row>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-text">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--accent)]"
      />
    </label>
  );
}

/**
 * A link's options: the table it links to (of the same base; fixed once the link exists),
 * "allow linking to multiple records" and "limit record selection to a view".
 */
function LinkOptionsControls({
  tableId,
  options,
  locked,
  set,
}: {
  tableId: string;
  options: Record<string, unknown>;
  locked: boolean;
  set: (key: string, value: unknown) => void;
}) {
  const baseId = useTable(tableId).data?.baseId ?? '';
  const tables = useTables(baseId).data?.tables ?? [];
  const linked = typeof options['linkedTableId'] === 'string' ? options['linkedTableId'] : '';
  const views = useViews(linked).data?.views ?? [];
  const viewId =
    typeof options['viewIdForRecordSelection'] === 'string'
      ? options['viewIdForRecordSelection']
      : '';
  return (
    <>
      <Row label="Link to table">
        {(id) => (
          <select
            id={id}
            value={linked}
            disabled={locked}
            onChange={(e) => {
              set('linkedTableId', e.target.value || null);
            }}
            className={selectClass}
          >
            {!linked && <option value="">Choose a table…</option>}
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id === tableId ? `${t.name} (this table)` : t.name}
              </option>
            ))}
          </select>
        )}
      </Row>
      <Toggle
        label="Allow linking to multiple records"
        checked={options['prefersSingleRecordLink'] !== true}
        onChange={(v) => set('prefersSingleRecordLink', !v)}
      />
      {linked && (
        <Row label="Limit record selection to a view">
          {(id) => (
            <select
              id={id}
              value={viewId}
              onChange={(e) => set('viewIdForRecordSelection', e.target.value || null)}
              className={selectClass}
            >
              <option value="">All records</option>
              {views.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          )}
        </Row>
      )}
    </>
  );
}

/**
 * The source of a lookup, rollup or count: a link field of this table, and for a
 * lookup or rollup a field of the table it links to. Picking another link clears the field.
 */
function ComputedSourceControls({
  options,
  fields,
  fieldId,
  withSourceField,
  verb,
  onChange,
}: {
  options: Record<string, unknown>;
  fields: readonly FieldMeta[];
  fieldId?: string;
  withSourceField: boolean;
  verb: string;
  onChange: (options: Record<string, unknown>) => void;
}) {
  const links = fields.filter(
    (f) => f.id !== fieldId && getFieldType(f.type).storage.kind === 'link'
  );
  const linkId =
    typeof options['recordLinkFieldId'] === 'string' ? options['recordLinkFieldId'] : '';
  const link = links.find((f) => f.id === linkId);
  const linkedTableId = (link?.options as { linkedTableId?: unknown } | undefined)?.linkedTableId;
  const linked = useTable(typeof linkedTableId === 'string' ? linkedTableId : '');
  const sourceId =
    typeof options['fieldIdInLinkedTable'] === 'string' ? options['fieldIdInLinkedTable'] : '';
  const sources = (linked.data?.fields ?? []).filter((f) => f.id !== fieldId);
  if (links.length === 0) {
    return (
      <p className="text-small text-text-2">
        This table has no linked record field yet. Add a “Link to another record” field first.
      </p>
    );
  }
  return (
    <>
      <Row label="Linked record field">
        {(id) => (
          <select
            id={id}
            value={linkId}
            onChange={(e) =>
              onChange({
                ...options,
                recordLinkFieldId: e.target.value || null,
                ...(withSourceField ? { fieldIdInLinkedTable: null } : {}),
              })
            }
            className={selectClass}
          >
            {!link && <option value="">Choose a field…</option>}
            {links.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </Row>
      {withSourceField && link && (
        <Row label={`Field to ${verb}`}>
          {(id) => (
            <select
              id={id}
              value={sourceId}
              disabled={!linked.data}
              onChange={(e) =>
                onChange({ ...options, fieldIdInLinkedTable: e.target.value || null })
              }
              className={selectClass}
            >
              {!sources.some((f) => f.id === sourceId) && (
                <option value="">{linked.data ? 'Choose a field…' : 'Loading fields…'}</option>
              )}
              {sources.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          )}
        </Row>
      )}
    </>
  );
}

/**
 * An AI field's options: the prompt with `{Field}` tokens (a click on a field inserts its
 * token at the cursor), what the answer becomes, a select's options, a number's decimals, and
 * whether a change to a referenced field generates the answer again.
 */
function AiOptionsControls({
  options,
  fields,
  fieldId,
  onChange,
}: {
  options: Record<string, unknown>;
  fields: readonly FieldMeta[];
  fieldId?: string | undefined;
  onChange: (options: Record<string, unknown>) => void;
}) {
  const set = (key: string, value: unknown) => onChange({ ...options, [key]: value });
  const promptId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const prompt = String(options['prompt'] ?? '');
  const output = String(options['output'] ?? 'text') as (typeof AI_FIELD_OUTPUTS)[number];
  // AI answers never feed a prompt (the server refuses them), so they aren't offered.
  const insertable = fields.filter((f) => f.id !== fieldId && f.type !== 'ai');
  const insert = (name: string) => {
    const el = area.current;
    const token = `{${name.replace(/[{}]/g, '')}}`;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const next = `${prompt.slice(0, start)}${token}${prompt.slice(end)}`;
    set('prompt', next.slice(0, AI_PROMPT_MAX));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-1.5 text-text">
        <label htmlFor={promptId}>Prompt</label>
        <textarea
          id={promptId}
          ref={area}
          value={prompt}
          maxLength={AI_PROMPT_MAX}
          rows={4}
          placeholder="Summarize {Notes} in one sentence."
          onChange={(e) => set('prompt', e.target.value)}
          className="min-h-20 w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 text-body text-text hover:border-border-strong"
        />
        {insertable.length > 0 && (
          <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0">
            <legend className="sr-only">Insert a field</legend>
            {insertable.slice(0, 50).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => insert(f.name)}
                className="h-6 max-w-40 truncate rounded-sm border border-border px-1.5 text-small text-text-2 hover:bg-hover"
              >
                {f.name}
              </button>
            ))}
          </fieldset>
        )}
        <p className="text-small text-text-2">
          Write fields as {'{Field name}'}. Answers come from this workspace&rsquo;s AI provider, in
          the background.
        </p>
      </div>
      <Select
        label="Output"
        value={output}
        values={AI_FIELD_OUTPUTS}
        text={(v) => AI_FIELD_OUTPUT_LABELS[v]}
        onChange={(v) => set('output', v)}
      />
      {output === 'singleSelect' && (
        <ChoiceEditor
          choices={(options['choices'] as Choice[] | undefined) ?? []}
          onChange={(c) => set('choices', c)}
        />
      )}
      {output === 'number' && (
        <Select
          label="Decimal places"
          value={
            options['precision'] === null || options['precision'] === undefined
              ? 'auto'
              : String(options['precision'])
          }
          values={['auto', '0', '1', '2', '3', '4', '5', '6', '7', '8']}
          text={(v) => (v === 'auto' ? 'Automatic' : `${v} (${(1).toFixed(Number(v))})`)}
          onChange={(v) => set('precision', v === 'auto' ? null : Number(v))}
        />
      )}
      <Toggle
        label="Update when referenced fields change"
        checked={options['autoUpdate'] !== false}
        onChange={(v) => set('autoUpdate', v)}
      />
    </div>
  );
}

export function FieldOptions({
  type,
  options,
  onChange,
  tableId,
  fields = [],
  fieldId,
  locked = false,
}: {
  type: FieldTypeName;
  options: Record<string, unknown>;
  onChange: (options: Record<string, unknown>) => void;
  /** The field's table (links pick a table of its base). */
  tableId: string;
  /** The table's live fields (formulas reference them). */
  fields?: readonly FieldMeta[];
  /** The edited field, absent for a new one. */
  fieldId?: string;
  /** An existing link: its linked table can't change. */
  locked?: boolean;
}) {
  if (type === 'ai') {
    return (
      <AiOptionsControls options={options} fields={fields} fieldId={fieldId} onChange={onChange} />
    );
  }
  const set = (key: string, value: unknown) => onChange({ ...options, [key]: value });
  const defaults = defaultOptions(type);
  // A formula's number and date formatting only show for a result of that type.
  // While the formula doesn't parse, the saved result type decides.
  const formulaType =
    typeof options['formula'] === 'string'
      ? (analyzeFormula(options['formula'], formulaFields(fields, fieldId)).type ??
        options['resultType'])
      : null;
  // A button has a label and a URL formula: its label comes first, and a URL has no
  // number or date formatting.
  const urlFormula = 'label' in defaults;
  // A rollup's decimal places apply to the functions giving a rounded number, its separator
  // to ARRAYJOIN.
  const rollupFn = 'function' in defaults ? String(options['function'] ?? '') : null;
  const keys = Object.keys(defaults).sort((a, b) => Number(b === 'label') - Number(a === 'label'));
  const controls = keys.map((key) => {
    const value = options[key];
    if (urlFormula && (key === 'precision' || key === 'timeZone')) return null;
    // A button that runs automations has no URL.
    if (urlFormula && key === 'formula' && options['action'] === 'runAutomation') return null;
    if (rollupFn !== null) {
      if (key === 'precision' && !ROUNDED_ROLLUPS.has(rollupFn)) return null;
      if (key === 'separator' && rollupFn !== 'ARRAYJOIN') return null;
    }
    if (formulaType !== null) {
      if (key === 'precision' && formulaType !== 'number') return null;
      if (key === 'timeZone' && formulaType !== 'date') return null;
    }
    switch (key) {
      case 'formula':
        return (
          <Suspense
            key={key}
            fallback={<p className="text-small text-text-2">Loading the formula editor…</p>}
          >
            <FormulaEditor
              value={String(value ?? '')}
              onChange={(v) => set(key, v)}
              fields={fields}
              fieldId={fieldId}
              tableId={tableId}
              options={options}
            />
          </Suspense>
        );
      case 'linkedTableId':
        return (
          <LinkOptionsControls
            key={key}
            tableId={tableId}
            options={options}
            locked={locked}
            set={set}
          />
        );
      case 'recordLinkFieldId':
        return (
          <ComputedSourceControls
            key={key}
            options={options}
            fields={fields}
            fieldId={fieldId}
            withSourceField={'fieldIdInLinkedTable' in defaults}
            verb={rollupFn !== null ? 'roll up' : 'look up'}
            onChange={onChange}
          />
        );
      case 'function':
        return (
          <Select
            key={key}
            label="Aggregation"
            value={String(value ?? 'SUM') as (typeof ROLLUP_FUNCTIONS)[number]}
            values={ROLLUP_FUNCTIONS}
            text={(v) => `${ROLLUP_LABELS[v]} · ${v}(values)`}
            onChange={(v) => set(key, v)}
          />
        );
      case 'separator':
        return (
          <Row key={key} label="Separator">
            {(id) => (
              <input
                id={id}
                value={String(value ?? '')}
                maxLength={100}
                onChange={(e) => set(key, e.target.value)}
                className={selectClass}
              />
            )}
          </Row>
        );
      case 'choices':
        return (
          <ChoiceEditor
            key={key}
            choices={(value as Choice[] | undefined) ?? []}
            onChange={(c) => set(key, c)}
          />
        );
      case 'precision':
        // `null` (formulas): as computed.
        if (defaults['precision'] === null) {
          return (
            <Select
              key={key}
              label="Decimal places"
              value={value === null || value === undefined ? 'auto' : String(value)}
              values={['auto', '0', '1', '2', '3', '4', '5', '6', '7', '8']}
              text={(v) => (v === 'auto' ? 'Automatic' : `${v} (${(1).toFixed(Number(v))})`)}
              onChange={(v) => set(key, v === 'auto' ? null : Number(v))}
            />
          );
        }
        return (
          <Select
            key={key}
            label="Decimal places"
            value={Number(value ?? 0)}
            values={[0, 1, 2, 3, 4, 5, 6, 7, 8]}
            text={(n) => `${n} (${(1).toFixed(n)})`}
            onChange={(v) => set(key, v)}
          />
        );
      case 'allowNegative':
        return (
          <Toggle
            key={key}
            label="Allow negative numbers"
            checked={value !== false}
            onChange={(v) => set(key, v)}
          />
        );
      case 'label':
        return (
          <Row key={key} label="Button label">
            {(id) => (
              <input
                id={id}
                value={String(value ?? '')}
                maxLength={100}
                placeholder="Open"
                onChange={(e) => set(key, e.target.value)}
                className={selectClass}
              />
            )}
          </Row>
        );
      case 'action':
        return (
          <Select
            key={key}
            label="When clicked"
            value={(value === 'runAutomation' ? 'runAutomation' : 'openUrl') as ButtonAction}
            values={BUTTON_ACTIONS}
            text={(v) => (v === 'runAutomation' ? 'Run automations' : 'Open a URL')}
            onChange={(v) => set(key, v)}
          />
        );
      case 'richText':
        return (
          <Toggle
            key={key}
            label="Enable rich text formatting"
            checked={value === true}
            onChange={(v) => set(key, v)}
          />
        );
      case 'multiple':
        return (
          <Toggle
            key={key}
            label="Allow adding multiple collaborators"
            checked={value === true}
            onChange={(v) => set(key, v)}
          />
        );
      case 'notify':
        return (
          <div key={key} className="grid gap-0.5">
            <Toggle
              label="Notify collaborators when they're added"
              checked={value === true}
              onChange={(v) => set(key, v)}
            />
            <p className="text-small text-text-2">Saved now; notifications arrive with mentions.</p>
          </div>
        );
      case 'currencyCode':
        return (
          <Row key={key} label="Currency code">
            {(id) => (
              <input
                id={id}
                value={String(value ?? '')}
                maxLength={3}
                onChange={(e) => set(key, e.target.value.toUpperCase())}
                className={selectClass}
              />
            )}
          </Row>
        );
      case 'dateFormat':
        return (
          <Select
            key={key}
            label="Date format"
            value={String(value) as (typeof DATE_FORMATS)[number]}
            values={DATE_FORMATS}
            text={(v) => DATE_FORMAT_LABELS[v]}
            onChange={(v) => set(key, v)}
          />
        );
      case 'timeFormat':
        return (
          <Select
            key={key}
            label="Time format"
            value={String(value) as (typeof TIME_FORMATS)[number]}
            values={TIME_FORMATS}
            text={(v) => TIME_FORMAT_LABELS[v]}
            onChange={(v) => set(key, v)}
          />
        );
      case 'timeZone':
        return (
          <Select
            key={key}
            label="Time zone"
            value={String(value ?? 'UTC')}
            values={timeZones()}
            text={(v) => v.replaceAll('_', ' ')}
            onChange={(v) => set(key, v)}
          />
        );
      case 'format':
        return (
          <Select
            key={key}
            label="Duration format"
            value={String(value) as (typeof DURATION_FORMATS)[number]}
            values={DURATION_FORMATS}
            text={(v) => v}
            onChange={(v) => set(key, v)}
          />
        );
      case 'max':
        return (
          <Select
            key={key}
            label="Maximum"
            value={Number(value ?? 5)}
            values={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]}
            text={String}
            onChange={(v) => set(key, v)}
          />
        );
      case 'icon':
        return (
          <Select
            key={key}
            label="Icon"
            value={String(value) as (typeof FIELD_ICONS)[number]}
            values={FIELD_ICONS}
            text={(v) => ICON_LABELS[v]}
            onChange={(v) => set(key, v)}
          />
        );
      case 'color':
        return (
          <Select
            key={key}
            label="Color"
            value={String(value) as (typeof CHOICE_COLORS)[number]}
            values={CHOICE_COLORS}
            text={capitalize}
            onChange={(v) => set(key, v)}
          />
        );
      default:
        return null;
    }
  });
  const shown = controls.filter(Boolean);
  if (shown.length === 0) return null;
  return <div className="grid gap-2.5">{shown}</div>;
}
