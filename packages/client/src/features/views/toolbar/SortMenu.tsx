import {
  type FieldMeta,
  getFieldType,
  MAX_GROUP_LEVELS,
  MAX_SORTS,
  type SortKind,
  type Sort as SortSpec,
} from '@openrows/shared';
import { ArrowUpDown, LayoutList, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { selectClass } from './FilterMenu';
import { ToolbarLabel } from './ToolbarLabel';

/** Direction labels per sort kind, as Airtable words them. */
const DIRECTION_LABELS: Record<SortKind, [string, string]> = {
  text: ['A → Z', 'Z → A'],
  number: ['1 → 9', '9 → 1'],
  boolean: ['unchecked → checked', 'checked → unchecked'],
  chronological: ['old → new', 'new → old'],
  choiceOrder: ['first → last', 'last → first'],
  none: ['ascending', 'descending'],
};

/** Fields the query engine can order by. */
export function sortableFields(fields: FieldMeta[]): FieldMeta[] {
  return fields.filter((f) => getFieldType(f.type).sort !== 'none');
}

/**
 * A list of sort keys: the toolbar's Sort (up to 10 keys) and Group (up to 3 levels) menus.
 * Each key is a field and a direction; a field appears once.
 */
function SortKeyMenu({
  label,
  icon,
  noun,
  empty,
  fields,
  keys,
  max,
  onChange,
}: {
  label: string;
  icon: ReactNode;
  noun: string;
  empty: string;
  fields: FieldMeta[];
  keys: SortSpec[];
  max: number;
  onChange: (keys: SortSpec[]) => void;
}) {
  const sortable = sortableFields(fields);
  const live = keys.filter((k) => sortable.some((f) => f.id === k.fieldId));
  const unused = sortable.filter((f) => !live.some((k) => k.fieldId === f.id));
  const next = unused[0];
  const set = (i: number, key: SortSpec | null) => {
    const out = [...live];
    if (key) out[i] = key;
    else out.splice(i, 1);
    onChange(out);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(live.length > 0 && 'bg-selected text-primary')}
          title={label}
        >
          {icon}
          <ToolbarLabel label={label} count={live.length} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[440px] max-w-[95vw]" aria-label={label}>
        {live.length === 0 && <p className="mb-2 text-text-2">{empty}</p>}
        <ul className="grid gap-1.5">
          {live.map((key, i) => {
            const field = sortable.find((f) => f.id === key.fieldId);
            const labels = DIRECTION_LABELS[field ? getFieldType(field.type).sort : 'none'];
            return (
              <li key={key.fieldId} className="flex items-center gap-1.5" data-testid={noun}>
                <span className="w-14 shrink-0 text-small text-text-2">
                  {i === 0 ? (noun === 'group' ? 'Group by' : 'Sort by') : 'then by'}
                </span>
                <select
                  aria-label={`${label} field ${i + 1}`}
                  value={key.fieldId}
                  onChange={(e) => set(i, { ...key, fieldId: e.target.value })}
                  className={cn(selectClass, 'min-w-0 flex-1')}
                >
                  {sortable
                    .filter((f) => f.id === key.fieldId || !live.some((k) => k.fieldId === f.id))
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
                <select
                  aria-label={`${label} direction ${i + 1}`}
                  value={key.direction}
                  onChange={(e) =>
                    set(i, { ...key, direction: e.target.value as SortSpec['direction'] })
                  }
                  className={cn(selectClass, 'w-40 shrink-0')}
                >
                  <option value="asc">{labels[0]}</option>
                  <option value="desc">{labels[1]}</option>
                </select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${noun} ${i + 1}`}
                  onClick={() => set(i, null)}
                >
                  <X aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          disabled={!next || live.length >= max}
          onClick={() => next && onChange([...live, { fieldId: next.id, direction: 'asc' }])}
        >
          <Plus aria-hidden /> {live.length === 0 ? `Pick a field to ${noun} by` : `Add ${noun}`}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function SortMenu(props: {
  fields: FieldMeta[];
  sorts: SortSpec[];
  onChange: (sorts: SortSpec[]) => void;
}) {
  return (
    <SortKeyMenu
      label="Sort"
      icon={<ArrowUpDown className="size-4" aria-hidden />}
      noun="sort"
      empty="No sorts are applied to this view."
      fields={props.fields}
      keys={props.sorts}
      max={MAX_SORTS}
      onChange={props.onChange}
    />
  );
}

export function GroupMenu(props: {
  fields: FieldMeta[];
  groupBy: SortSpec[];
  onChange: (groupBy: SortSpec[]) => void;
}) {
  return (
    <SortKeyMenu
      label="Group"
      icon={<LayoutList className="size-4" aria-hidden />}
      noun="group"
      empty="Records aren't grouped. Group by up to 3 fields."
      fields={props.fields}
      keys={props.groupBy}
      max={MAX_GROUP_LEVELS}
      onChange={props.onChange}
    />
  );
}
