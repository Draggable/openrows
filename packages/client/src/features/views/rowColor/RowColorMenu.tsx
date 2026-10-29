import {
  CHOICE_COLORS,
  type ChoiceColor,
  type FieldMeta,
  type FilterCondition,
  isFilterSubgroup,
  MAX_ROW_COLOR_CONDITIONS,
  type RowColor,
  type RowColorCondition,
} from '@openrows/shared';
import { Palette, Plus, X } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { ConditionRow, selectClass } from '../toolbar/FilterMenu';
import { newCondition } from '../toolbar/model';
import { ToolbarLabel } from '../toolbar/ToolbarLabel';
import { colorableFields, newColorCondition } from './model';

const colorName = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);

type Mode = 'none' | RowColor['mode'];

/**
 * The view's row colouring (Airtable's "Color"): none, by a single select field's choice
 * colours, or by conditions (each a colour and filter conditions joined by "and"; the first
 * match wins).
 */
export function RowColorMenu({
  fields,
  rowColor,
  onChange,
}: {
  fields: FieldMeta[];
  rowColor: RowColor | null;
  onChange: (rowColor: RowColor | null) => void;
}) {
  const selects = colorableFields(fields);
  const mode: Mode = rowColor?.mode ?? 'none';
  const conditions = rowColor?.mode === 'conditions' ? rowColor.conditions : [];
  const setConditions = (next: RowColorCondition[]) =>
    onChange({ mode: 'conditions', conditions: next });
  const setMode = (next: Mode) => {
    if (next === 'none') onChange(null);
    else if (next === 'select') {
      const first = selects[0];
      if (first) onChange({ mode: 'select', fieldId: first.id });
    } else {
      const first = newColorCondition(fields, 0, CHOICE_COLORS);
      setConditions(first ? [first] : []);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(mode !== 'none' && 'bg-selected text-primary')}
          title="Color"
        >
          <Palette className="size-4" aria-hidden />
          <ToolbarLabel label="Color" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[640px] max-w-[95vw]" aria-label="Row colors">
        <fieldset className="mb-3 flex gap-4">
          <legend className="sr-only">Color rows</legend>
          {(
            [
              ['none', 'None'],
              ['select', 'By select field'],
              ['conditions', 'By conditions'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="row-color-mode"
                checked={mode === value}
                disabled={value === 'select' && selects.length === 0}
                onChange={() => setMode(value)}
                className="accent-[var(--accent)]"
              />
              {label}
            </label>
          ))}
        </fieldset>
        {rowColor?.mode === 'select' && (
          <label className="flex items-center gap-2">
            <span className="text-text-2">Color records by</span>
            <select
              aria-label="Color by field"
              value={rowColor.fieldId}
              onChange={(e) => onChange({ mode: 'select', fieldId: e.target.value })}
              className={cn(selectClass, 'w-48')}
            >
              {selects.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {rowColor?.mode === 'conditions' && (
          <>
            <p className="mb-2 text-small text-text-2">
              Records get the color of the first condition they match.
            </p>
            <ul className="grid gap-3">
              {conditions.map((c, i) => (
                <ColorConditionEditor
                  // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id
                  key={i}
                  index={i}
                  fields={fields}
                  condition={c}
                  onChange={(next) =>
                    setConditions(
                      next
                        ? conditions.map((x, j) => (j === i ? next : x))
                        : conditions.filter((_, j) => j !== i)
                    )
                  }
                />
              ))}
            </ul>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3"
              disabled={conditions.length >= MAX_ROW_COLOR_CONDITIONS || fields.length === 0}
              onClick={() => {
                const next = newColorCondition(fields, conditions.length, CHOICE_COLORS);
                if (next) setConditions([...conditions, next]);
              }}
            >
              <Plus aria-hidden /> Add color condition
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function ColorConditionEditor({
  index,
  fields,
  condition,
  onChange,
}: {
  index: number;
  fields: FieldMeta[];
  condition: RowColorCondition;
  onChange: (next: RowColorCondition | null) => void;
}) {
  const entries = condition.filter.conditions;
  const setEntries = (next: RowColorCondition['filter']['conditions']) =>
    onChange({ ...condition, filter: { ...condition.filter, conditions: next } });
  const first = fields[0];
  return (
    <li
      className="grid gap-1.5 rounded-sm border border-border p-2"
      data-testid="row-color-condition"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-full"
          style={{ background: `var(--chip-${condition.color})` }}
        />
        <select
          aria-label={`Color of condition ${index + 1}`}
          value={condition.color}
          onChange={(e) => onChange({ ...condition, color: e.target.value as ChoiceColor })}
          className={cn(selectClass, 'w-28')}
        >
          {CHOICE_COLORS.map((color) => (
            <option key={color} value={color}>
              {colorName(color)}
            </option>
          ))}
        </select>
        <span className="text-small text-text-2">when all of these are true</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label={`Remove color condition ${index + 1}`}
          onClick={() => onChange(null)}
        >
          <X aria-hidden />
        </Button>
      </div>
      <ul className="grid gap-1.5">
        {entries.map((entry, i) =>
          isFilterSubgroup(entry) ? null : (
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id
            <li key={i} className="flex">
              <ConditionRow
                fields={fields}
                cond={entry}
                onChange={(next: FilterCondition | null) =>
                  setEntries(
                    next
                      ? entries.map((x, j) => (j === i ? next : x))
                      : entries.filter((_, j) => j !== i)
                  )
                }
              />
            </li>
          )
        )}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        className="justify-self-start"
        disabled={!first}
        onClick={() => first && setEntries([...entries, newCondition(first)])}
      >
        <Plus aria-hidden /> Add condition
      </Button>
    </li>
  );
}
