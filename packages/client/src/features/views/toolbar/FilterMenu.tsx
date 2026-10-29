import {
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type FilterSubgroup,
  isFilterSubgroup,
  ME_TOKEN,
} from '@openrows/shared';
import { Filter, Plus, X } from 'lucide-react';
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { useDirectory } from '../../collaborators/context';
import { userOptions, userValueLabel } from '../../collaborators/model';
import { Avatar } from '../../collaborators/UserChip';
import { choicesOf, parseInput } from '../../grid/cells';
import {
  activeConditionCount,
  canAddCondition,
  newCondition,
  OPERATOR_LABELS,
  operatorsFor,
  RELATIVE_DATES,
  setEntry,
  valueInputFor,
  WITHIN_PRESETS,
  withOperator,
} from './model';
import { RecordFilterPicker } from './RecordFilterPicker';
import { ToolbarLabel } from './ToolbarLabel';

export const selectClass =
  'h-7 rounded-sm border border-border bg-surface px-1.5 text-body text-text hover:border-border-strong';

type Conjunction = 'and' | 'or';

/**
 * The filter builder: conditions and one level of condition groups, joined by and/or,
 * with the operators the field's type offers and a value input that fits it. Read-only roles
 * can still filter for themselves; nothing is saved for them.
 */
export function FilterMenu({
  fields,
  filter,
  onChange,
}: {
  fields: FieldMeta[];
  filter: FilterGroup;
  onChange: (filter: FilterGroup) => void;
}) {
  const active = activeConditionCount(filter);
  const first = fields[0];
  const canAdd = first !== undefined && canAddCondition(filter);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(active > 0 && 'bg-selected text-primary')}
          title="Filter"
        >
          <Filter className="size-4" aria-hidden />
          <ToolbarLabel label="Filter" count={active} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[640px] max-w-[95vw]" aria-label="Filter">
        {filter.conditions.length === 0 ? (
          <p className="mb-2 text-text-2">No filter conditions are applied to this view.</p>
        ) : (
          <p className="mb-2 text-small text-text-2">In this view, show records</p>
        )}
        <ul className="grid gap-1.5">
          {filter.conditions.map((entry, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id
              key={i}
              className="flex items-start gap-1.5"
            >
              <ConjunctionCell
                index={i}
                value={filter.conjunction}
                onChange={(conjunction) => onChange({ ...filter, conjunction })}
              />
              {isFilterSubgroup(entry) ? (
                <SubgroupEditor
                  fields={fields}
                  group={entry}
                  canAdd={canAdd}
                  onChange={(next) => onChange(setEntry(filter, i, next))}
                />
              ) : (
                <ConditionRow
                  fields={fields}
                  cond={entry}
                  onChange={(next) => onChange(setEntry(filter, i, next))}
                />
              )}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={!canAdd}
            onClick={() =>
              first &&
              onChange({ ...filter, conditions: [...filter.conditions, newCondition(first)] })
            }
          >
            <Plus aria-hidden /> Add condition
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canAdd}
            onClick={() =>
              first &&
              onChange({
                ...filter,
                conditions: [
                  ...filter.conditions,
                  { conjunction: 'and', conditions: [newCondition(first)] },
                ],
              })
            }
          >
            <Plus aria-hidden /> Add condition group
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** "Where" before the first entry, the and/or picker before the second, its value after. */
function ConjunctionCell({
  index,
  value,
  onChange,
}: {
  index: number;
  value: Conjunction;
  onChange: (c: Conjunction) => void;
}) {
  if (index === 0) return <span className="w-20 shrink-0 px-1.5 leading-7 text-text-2">Where</span>;
  if (index > 1) return <span className="w-20 shrink-0 px-1.5 leading-7 text-text-2">{value}</span>;
  return (
    <select
      aria-label="Conjunction"
      value={value}
      onChange={(e) => onChange(e.target.value as Conjunction)}
      className={cn(selectClass, 'w-20 shrink-0')}
    >
      <option value="and">and</option>
      <option value="or">or</option>
    </select>
  );
}

function SubgroupEditor({
  fields,
  group,
  canAdd,
  onChange,
}: {
  fields: FieldMeta[];
  group: FilterSubgroup;
  canAdd: boolean;
  onChange: (group: FilterSubgroup | null) => void;
}) {
  const first = fields[0];
  return (
    <fieldset
      aria-label="Condition group"
      className="grid min-w-0 flex-1 gap-1.5 rounded-sm border border-border bg-app p-2"
    >
      {group.conditions.map((cond, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id
          key={i}
          className="flex items-start gap-1.5"
        >
          <ConjunctionCell
            index={i}
            value={group.conjunction}
            onChange={(conjunction) => onChange({ ...group, conjunction })}
          />
          <ConditionRow
            fields={fields}
            cond={cond}
            onChange={(next) => {
              const conditions = [...group.conditions];
              if (next) conditions[i] = next;
              else conditions.splice(i, 1);
              onChange(conditions.length > 0 ? { ...group, conditions } : null);
            }}
          />
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={!canAdd}
          onClick={() =>
            first && onChange({ ...group, conditions: [...group.conditions, newCondition(first)] })
          }
        >
          <Plus aria-hidden /> Add condition
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
          Delete group
        </Button>
      </div>
    </fieldset>
  );
}

export function ConditionRow({
  fields,
  cond,
  onChange,
}: {
  fields: FieldMeta[];
  cond: FilterCondition;
  onChange: (cond: FilterCondition | null) => void;
}) {
  const field = fields.find((f) => f.id === cond.fieldId);
  return (
    <div className="flex min-w-0 flex-1 items-start gap-1.5" data-testid="filter-condition">
      <select
        aria-label="Field"
        value={cond.fieldId}
        onChange={(e) => {
          const next = fields.find((f) => f.id === e.target.value);
          if (next) onChange(newCondition(next));
        }}
        className={cn(selectClass, 'w-36 shrink-0')}
      >
        {!field && <option value={cond.fieldId}>Deleted field</option>}
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {field && (
        <>
          <select
            aria-label="Operator"
            value={cond.operator}
            onChange={(e) =>
              onChange(withOperator(field, cond, e.target.value as FilterCondition['operator']))
            }
            className={cn(selectClass, 'w-32 shrink-0')}
          >
            {operatorsFor(field).map((op) => (
              <option key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </option>
            ))}
          </select>
          <div className="min-w-0 flex-1">
            <ValueInput
              field={field}
              cond={cond}
              onChange={(value) => {
                const next: FilterCondition = { fieldId: cond.fieldId, operator: cond.operator };
                if (value !== undefined) next.value = value;
                onChange(next);
              }}
            />
          </div>
        </>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Remove condition"
        onClick={() => onChange(null)}
      >
        <X aria-hidden />
      </Button>
    </div>
  );
}

function ValueInput({
  field,
  cond,
  onChange,
}: {
  field: FieldMeta;
  cond: FilterCondition;
  onChange: (value: unknown) => void;
}) {
  const kind = valueInputFor(field, cond.operator);
  const directory = useDirectory();
  const value = cond.value;
  const label = `Value of ${field.name}`;
  switch (kind) {
    case 'none':
    case 'unsupported':
      return null;
    case 'boolean':
      return (
        <select
          aria-label={label}
          value={value === false ? 'false' : 'true'}
          onChange={(e) => onChange(e.target.value === 'true')}
          className={cn(selectClass, 'w-full')}
        >
          <option value="true">checked</option>
          <option value="false">unchecked</option>
        </select>
      );
    case 'within':
      return (
        <select
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cn(selectClass, 'w-full')}
        >
          <option value="">Pick a range…</option>
          {Object.entries(WITHIN_PRESETS).map(([k, text]) => (
            <option key={k} value={k}>
              {text}
            </option>
          ))}
        </select>
      );
    case 'date': {
      const relative = (RELATIVE_DATES as readonly unknown[]).includes(value);
      return (
        <div className="flex gap-1.5">
          <select
            aria-label={`Date of ${field.name}`}
            value={relative ? String(value) : 'exact'}
            onChange={(e) => onChange(e.target.value === 'exact' ? undefined : e.target.value)}
            className={cn(selectClass, 'w-24 shrink-0')}
          >
            {RELATIVE_DATES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
            <option value="exact">exact date</option>
          </select>
          {!relative && (
            <Input
              type="date"
              aria-label={label}
              className="h-7"
              value={typeof value === 'string' ? value : ''}
              onChange={(e) => onChange(e.target.value || undefined)}
            />
          )}
        </div>
      );
    }
    case 'choice':
      return (
        <select
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cn(selectClass, 'w-full')}
        >
          <option value="">Pick an option…</option>
          {choicesOf(field).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      );
    case 'choices': {
      const picked = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="flex flex-wrap gap-1" aria-label={label}>
          {choicesOf(field).map((c) => {
            const on = picked.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? picked.filter((id) => id !== c.id) : [...picked, c.id];
                  onChange(next.length > 0 ? next : undefined);
                }}
                className={cn(
                  'h-7 rounded-sm border border-border px-2 text-small hover:bg-hover',
                  on && 'border-primary bg-selected text-primary'
                )}
              >
                {c.name}
              </button>
            );
          })}
        </fieldset>
      );
    }
    case 'user':
      return (
        <select
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className={cn(selectClass, 'w-full')}
        >
          <option value="">Pick a collaborator…</option>
          {userOptions(directory.list, directory.meId).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {typeof value === 'string' && value !== ME_TOKEN && !directory.byId.has(value) && (
            <option value={value}>{userValueLabel(value, directory.byId)}</option>
          )}
        </select>
      );
    case 'users': {
      const picked = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="flex max-h-40 flex-wrap gap-1 overflow-y-auto" aria-label={label}>
          {userOptions(directory.list, directory.meId).map((o) => {
            const on = picked.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? picked.filter((id) => id !== o.value) : [...picked, o.value];
                  onChange(next.length > 0 ? next : undefined);
                }}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-sm border border-border px-2 text-small hover:bg-hover',
                  on && 'border-primary bg-selected text-primary'
                )}
              >
                {o.person && <Avatar person={o.person} className="size-4 text-[9px]" />}
                {o.label}
              </button>
            );
          })}
        </fieldset>
      );
    }
    case 'records':
      return <RecordFilterPicker field={field} value={value} onChange={onChange} />;
    case 'number':
      return (
        <NumberValue
          key={`${field.id}:${cond.operator}`}
          field={field}
          label={label}
          value={value}
          onChange={(v) => onChange(v)}
        />
      );
    default:
      return (
        <Input
          aria-label={label}
          className="h-7"
          placeholder="Enter a value"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      );
  }
}

/**
 * A number typed as the field shows it (a percent as 50, a duration as 1:30), stored the way
 * the query compares it (a fraction, seconds), through the registry's `coerce`. Uncontrolled, so
 * text that doesn't read yet stays as typed.
 */
function NumberValue({
  field,
  label,
  value,
  onChange,
}: {
  field: FieldMeta;
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  return (
    <Input
      aria-label={label}
      className="h-7"
      inputMode="decimal"
      placeholder="Enter a number"
      defaultValue={typeof value === 'number' ? displayNumber(field, value) : ''}
      onChange={(e) => {
        const parsed = parseInput(field, e.target.value);
        onChange(typeof parsed === 'number' ? parsed : undefined);
      }}
    />
  );
}

function displayNumber(field: FieldMeta, value: number): string {
  // Round-trip through the same reading: a percent fraction shows as its percentage.
  for (const candidate of [String(value), String(value * 100)]) {
    if (parseInput(field, candidate) === value) return candidate;
  }
  return String(value);
}
