import {
  type CalendarDateFields,
  type CalendarLayout,
  type CalendarMode,
  type FieldMeta,
  MAX_CALENDAR_DATE_FIELDS,
  type SavedViewQuery,
} from '@openrows/shared';
import { CalendarDays, ChevronLeft, ChevronRight, Inbox, Plus, Search, X } from 'lucide-react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { FilterMenu } from '../toolbar/FilterMenu';
import type { ToolbarQuery } from '../toolbar/model';
import { FIND_BOX_CLASS, TOOLBAR_CLASS, ToolbarLabel } from '../toolbar/ToolbarLabel';
import { dateFieldsOf } from './model';

const MODES: { mode: CalendarMode; label: string }[] = [
  { mode: 'month', label: 'Month' },
  { mode: 'week', label: 'Week' },
  { mode: 'day', label: 'Day' },
];

const selectClass = 'h-8 min-w-0 flex-1 rounded-sm border border-border bg-surface px-2 text-body';

/**
 * The calendar toolbar: previous / today / next and the range's title, the month, week or
 * day layout, the date field pairs and the colour field, filter, find, the undated records'
 * panel and the record count of the visible range.
 */
export function CalendarToolbar({
  fields,
  layout,
  mode,
  title,
  onLayoutChange,
  onStep,
  onToday,
  query,
  onQueryChange,
  search,
  onSearchChange,
  undatedOpen,
  onUndatedToggle,
  undatedCount,
  count,
}: {
  fields: FieldMeta[];
  layout: CalendarLayout;
  mode: CalendarMode;
  title: string;
  onLayoutChange: (patch: CalendarLayout) => void;
  onStep: (step: 1 | -1) => void;
  onToday: () => void;
  query: ToolbarQuery;
  onQueryChange: (patch: SavedViewQuery) => void;
  search: string;
  onSearchChange: (search: string) => void;
  undatedOpen: boolean;
  onUndatedToggle: () => void;
  undatedCount: number | undefined;
  count: string;
}) {
  return (
    <div role="toolbar" aria-label="View" className={TOOLBAR_CLASS}>
      <Button variant="outline" size="sm" onClick={onToday}>
        Today
      </Button>
      <Button variant="ghost" size="icon" aria-label="Previous" onClick={() => onStep(-1)}>
        <ChevronLeft className="size-4" aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Next" onClick={() => onStep(1)}>
        <ChevronRight className="size-4" aria-hidden />
      </Button>
      <h2 className="mr-2 whitespace-nowrap text-body font-semibold" aria-live="polite">
        {title}
      </h2>
      <fieldset className="flex items-center rounded-sm border border-border p-0.5">
        <legend className="sr-only">Layout</legend>
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            aria-pressed={mode === m.mode}
            onClick={() => onLayoutChange({ mode: m.mode })}
            className={cn(
              'h-6 rounded-[3px] px-2 text-small text-text-2 hover:bg-hover',
              mode === m.mode && 'bg-selected font-medium text-text'
            )}
          >
            {m.label}
          </button>
        ))}
      </fieldset>
      <DateFieldsMenu fields={fields} layout={layout} onLayoutChange={onLayoutChange} />
      <FilterMenu
        fields={fields}
        filter={query.filter}
        onChange={(filter) => onQueryChange({ filter })}
      />
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={undatedOpen}
        onClick={onUndatedToggle}
        className={cn(undatedOpen && 'bg-selected')}
        title="Undated"
      >
        <Inbox className="size-4 text-text-2" aria-hidden />
        <ToolbarLabel label="Undated" count={undatedCount} />
      </Button>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <div className={cn(FIND_BOX_CLASS, 'w-56')}>
          <Search className="size-4 shrink-0 text-text-3" aria-hidden />
          <input
            type="search"
            aria-label="Find in view"
            placeholder="Find in view"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onSearchChange('');
            }}
            className="min-w-0 flex-1 bg-transparent text-body outline-none focus-visible:shadow-none placeholder:text-text-3 [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <p className="tnum whitespace-nowrap text-text-2" data-testid="record-count">
          {count}
        </p>
      </div>
    </div>
  );
}

/** The date field pairs (start, optional end) and the colour field. */
function DateFieldsMenu({
  fields,
  layout,
  onLayoutChange,
}: {
  fields: FieldMeta[];
  layout: CalendarLayout;
  onLayoutChange: (patch: CalendarLayout) => void;
}) {
  const dates = dateFieldsOf(fields);
  const selects = fields.filter((f) => f.type === 'singleSelect');
  const pairs = layout.dateFields ?? [];
  const setPairs = (dateFields: CalendarDateFields[]) => onLayoutChange({ dateFields });
  const setPair = (i: number, patch: Partial<CalendarDateFields>) =>
    setPairs(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const unused = dates.find((f) => !pairs.some((p) => p.startFieldId === f.id));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <CalendarDays className="size-4 text-text-2" aria-hidden />
          Date fields{pairs.length > 0 ? ` (${pairs.length})` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[26rem]" aria-label="Date fields">
        {dates.length === 0 && (
          <p className="text-text-2">Add a date field to the table to use a calendar.</p>
        )}
        <ul className="grid gap-2" aria-label="Date field pairs">
          {pairs.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: pairs have no id; a start may repeat
            <li key={`${p.startFieldId}-${i}`} className="flex items-center gap-2">
              <select
                aria-label={`Start field ${i + 1}`}
                value={p.startFieldId}
                onChange={(e) => setPair(i, { startFieldId: e.target.value })}
                className={selectClass}
              >
                {dates.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <span className="text-text-3" aria-hidden>
                –
              </span>
              <select
                aria-label={`End field ${i + 1}`}
                value={p.endFieldId ?? ''}
                onChange={(e) => setPair(i, { endFieldId: e.target.value || null })}
                className={selectClass}
              >
                <option value="">No end (single day)</option>
                {dates
                  .filter((f) => f.id !== p.startFieldId)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove date field pair ${i + 1}`}
                onClick={() => setPairs(pairs.filter((_, j) => j !== i))}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        {unused && pairs.length < MAX_CALENDAR_DATE_FIELDS && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setPairs([...pairs, { startFieldId: unused.id, endFieldId: null }])}
          >
            <Plus className="size-4" aria-hidden />
            Add date field
          </Button>
        )}
        <label className="mt-3 flex flex-col gap-1 text-small text-text-2">
          Colour events by
          <select
            value={layout.colorFieldId ?? ''}
            onChange={(e) => onLayoutChange({ colorFieldId: e.target.value || null })}
            className="h-8 rounded-sm border border-border bg-surface px-2 text-body text-text"
          >
            <option value="">Date field</option>
            {selects.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      </PopoverContent>
    </Popover>
  );
}
