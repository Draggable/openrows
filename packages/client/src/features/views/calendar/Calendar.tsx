import type {
  CalendarLayout,
  CalendarMode,
  ChoiceColor,
  FieldMeta,
  RecordData,
  SavedViewQuery,
  TableMeta,
  UserRole,
  ViewMeta,
  ViewQuery,
} from '@openrows/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Plus } from 'lucide-react';
import {
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, api } from '../../../api/client';
import { queryKeys } from '../../../api/keys';
import { recordQueries, useUpdateView } from '../../../api/queries';
import { Button, toast } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { chipStyle } from '../../grid/cells/CellContent';
import { cellText, choicesOf } from '../../grid/cells/model';
import { type ExpandLayout, storedLayout, storeLayout } from '../../record/model';
import { RecordExpand, useDeleteRecordWithUndo } from '../../record/RecordExpand';
import { canConfigureView } from '../access';
import { useDebounced, useViewQuery } from '../toolbar/useViewQuery';
import { CalendarToolbar } from './CalendarToolbar';
import {
  addDays,
  type CalendarEvent,
  type DatePair,
  dateFieldsOf,
  datePairsOf,
  dayLabel,
  daysBetween,
  eventsOf,
  isEditableDate,
  keyboardChange,
  layoutRow,
  localToday,
  movePatch,
  rangeFieldsOf,
  rangeTitle,
  resizePatch,
  type Segment,
  stepAnchor,
  undatedWithin,
  valueOnDay,
  visibleWeeks,
  WEEKDAYS,
} from './model';

const QUERY_DELAY = 250;
/** Records one range query loads; more show a notice (the range is a month at most). */
const RANGE_LIMIT = 1000;
const UNDATED_LIMIT = 200;
const LANE = 24;
const DAY_HEADER = 28;
/** Lanes a month row shows before "+N more". */
const MONTH_LANES = 3;

/** What is being dragged: an event (from the day it was grabbed by) or an undated record. */
type Dragging = { event: CalendarEvent; grabDay: string } | { record: RecordData };

/**
 * The calendar view: records placed on a month, week or day by one or more date field
 * pairs (a start and an optional end: ranges span days), each pair in its legend colour or
 * events coloured by a single select. Only the visible days are fetched (`dateRange`). Events
 * drag to another day (the start and end move together), ranges resize from their end, and a
 * focused event moves with Alt+arrow keys (Alt+Shift+Left/Right resizes). "+" on a day creates a
 * record there; records without a date wait in the "Undated" panel and drag onto a day.
 */
export function Calendar({
  table,
  view,
  viewId,
  role,
  expandedRecordId,
  onExpandRecord,
}: {
  table: TableMeta;
  view: ViewMeta | undefined;
  viewId: string;
  role: UserRole | undefined;
  expandedRecordId?: string | undefined;
  onExpandRecord: (recordId: string | null) => void;
}) {
  const qc = useQueryClient();
  const canEdit = role === 'owner' || role === 'creator' || role === 'editor';
  const canConfigure = canConfigureView(role, view);
  const fields = useMemo(() => table.fields.filter((f) => !f.deletedAt), [table.fields]);
  const primary = fields.find((f) => f.isPrimary);

  // The layout: saved for editors and up, kept for the page for lower roles.
  const updateView = useUpdateView(table.id);
  const [localLayout, setLocalLayout] = useState<CalendarLayout>({});
  const saved = view?.config.calendar;
  const layout: CalendarLayout = useMemo(
    () => ({ ...saved, ...localLayout }),
    [saved, localLayout]
  );
  const saveLayout = (patch: CalendarLayout) => {
    setLocalLayout((l) => ({ ...l, ...patch }));
    if (!canConfigure || !view) return;
    updateView.mutate(
      { viewId: view.id, calendar: patch },
      { onError: () => toast.error("Couldn't save the calendar's settings") }
    );
  };
  const mode: CalendarMode = layout.mode ?? 'month';
  const pairs = useMemo(() => datePairsOf(fields, layout), [fields, layout]);
  const colorField = fields.find((f) => f.id === layout.colorFieldId && f.type === 'singleSelect');

  const [anchor, setAnchor] = useState(() => localToday());
  const today = localToday();
  const weeks = useMemo(() => visibleWeeks(mode, anchor), [mode, anchor]);
  const from = weeks[0]?.[0] ?? anchor;
  const to = weeks.at(-1)?.at(-1) ?? anchor;

  const viewQuery = useViewQuery(table, view, canConfigure);
  const [search, setSearch] = useState('');
  const applied: Partial<ViewQuery> = useDebounced(
    {
      ...(view ? { filter: viewQuery.query.filter } : {}),
      sorts: [],
      groupBy: [],
      ...(search.trim() ? { search: search.trim() } : {}),
    },
    QUERY_DELAY
  );

  const rangeFields = rangeFieldsOf(pairs);
  const ranged = useQuery({
    ...recordQueries.query(table.id, {
      viewId,
      query: { ...applied, dateRange: { from, to, fields: rangeFields } },
      limit: RANGE_LIMIT,
      count: true,
    }),
    enabled: pairs.length > 0,
  });
  const [undatedOpen, setUndatedOpen] = useState(false);
  const undated = useQuery({
    ...recordQueries.query(table.id, {
      viewId,
      query: { ...applied, within: undatedWithin(pairs) },
      limit: undatedOpen ? UNDATED_LIMIT : 0,
      count: true,
    }),
    enabled: pairs.length > 0,
  });

  // Edits in flight show at once; the refetch replaces them.
  const [pending, setPending] = useState<Map<string, Record<string, unknown>>>(new Map());
  const [resizing, setResizing] = useState<{ key: string; end: string } | null>(null);
  const records = useMemo(() => {
    const loaded = ranged.data?.records ?? [];
    if (pending.size === 0) return loaded;
    return loaded.map((r) => {
      const patch = pending.get(r.id);
      return patch ? { ...r, fields: { ...r.fields, ...patch } } : r;
    });
  }, [ranged.data, pending]);
  const events = useMemo(() => {
    const all = eventsOf(records, pairs, colorField);
    if (!resizing) return all;
    return all.map((e) =>
      // A range never ends before it starts (days compare as text).
      e.key === resizing.key ? { ...e, end: [e.start, resizing.end].sort()[1] ?? e.start } : e
    );
  }, [records, pairs, colorField, resizing]);

  const [announcement, setAnnouncement] = useState('');
  // The event to focus once it renders where it went (its key and new start day).
  const focusKey = useRef<{ key: string; start: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = focusKey.current;
    if (!target) return;
    const el = gridRef.current?.querySelector<HTMLElement>(
      `[data-event-key="${target.key}"][data-event-start="${target.start}"]`
    );
    if (el) {
      focusKey.current = null;
      el.focus();
    }
  });

  const titleOf = (record: RecordData) =>
    (primary ? cellText(primary, record.fields[primary.id]) : '') || 'Unnamed record';

  const save = async (record: RecordData, patch: Record<string, unknown>, message: string) => {
    setPending((p) => new Map(p).set(record.id, { ...p.get(record.id), ...patch }));
    try {
      await api.records.update({
        params: { tableId: table.id, recordId: record.id },
        body: { fields: patch },
      });
      setAnnouncement(message);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't reschedule the record");
    } finally {
      await qc.invalidateQueries({ queryKey: queryKeys.records.table(table.id) });
      setPending((p) => {
        const next = new Map(p);
        next.delete(record.id);
        return next;
      });
    }
  };

  const moveBy = (event: CalendarEvent, days: number) => {
    const patch = movePatch(event, days);
    if (!patch || !canEdit) return;
    const day = addDays(event.start, days);
    if (day < from || day > to) setAnchor(day);
    focusKey.current = { key: event.key, start: day };
    void save(event.record, patch, `Moved ${titleOf(event.record)} to ${dayLabel(day)}.`);
  };
  const resizeTo = (event: CalendarEvent, endDay: string) => {
    const patch = resizePatch(event, endDay);
    if (!patch || !canEdit) return;
    focusKey.current = { key: event.key, start: event.start };
    const end = endDay < event.start ? event.start : endDay;
    void save(event.record, patch, `${titleOf(event.record)} now ends ${dayLabel(end)}.`);
  };
  const firstEditable = pairs.find((p) => isEditableDate(p.start));
  const schedule = (record: RecordData, day: string) => {
    if (!firstEditable || !canEdit) return;
    void save(
      record,
      { [firstEditable.start.id]: valueOnDay(firstEditable.start, day) },
      `Scheduled ${titleOf(record)} on ${dayLabel(day)}.`
    );
  };

  // Drag and drop: rows find the day under the pointer from its x.
  const dragging = useRef<Dragging | null>(null);
  const [overDay, setOverDay] = useState<string | null>(null);
  const dayAt = (row: HTMLElement, days: readonly string[], clientX: number) => {
    const rect = row.getBoundingClientRect();
    const col = Math.floor(((clientX - rect.left) / rect.width) * days.length);
    return days[Math.max(0, Math.min(days.length - 1, col))] ?? null;
  };
  const onRowDragOver = (e: DragEvent<HTMLElement>, days: readonly string[]) => {
    if (!dragging.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const day = dayAt(e.currentTarget, days, e.clientX);
    if (day !== overDay) setOverDay(day);
  };
  const onRowDrop = (e: DragEvent<HTMLElement>, days: readonly string[]) => {
    const d = dragging.current;
    dragging.current = null;
    setOverDay(null);
    if (!d) return;
    e.preventDefault();
    const day = dayAt(e.currentTarget, days, e.clientX);
    if (!day) return;
    if ('event' in d) moveBy(d.event, daysBetween(d.grabDay, day));
    else schedule(d.record, day);
  };
  const onEventDragStart = (e: DragEvent<HTMLElement>, event: CalendarEvent, days: string[]) => {
    const row = e.currentTarget.closest<HTMLElement>('[data-week]');
    const grabbed = row ? dayAt(row, days, e.clientX) : null;
    const grabDay =
      grabbed && grabbed >= event.start && grabbed <= event.end ? grabbed : event.start;
    dragging.current = { event, grabDay };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', titleOf(event.record));
  };

  // Resizing from a range's end: the day under the pointer, in any row.
  const onResizeStart = (e: PointerEvent<HTMLElement>, event: CalendarEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let end = event.end;
    setResizing({ key: event.key, end });
    const onMove = (m: globalThis.PointerEvent) => {
      const row = document
        .elementsFromPoint(m.clientX, m.clientY)
        .find(
          (el): el is HTMLElement => el instanceof HTMLElement && el.dataset['week'] !== undefined
        );
      const days = row?.dataset['days']?.split(',');
      if (!row || !days) return;
      const day = dayAt(row, days, m.clientX);
      if (day && day !== end) {
        end = day;
        setResizing({ key: event.key, end });
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setResizing(null);
      resizeTo(event, end);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onEventKey = (e: KeyboardEvent<HTMLElement>, event: CalendarEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onExpandRecord(event.record.id);
      return;
    }
    if (!e.altKey) return;
    const change = keyboardChange(e.key, e.shiftKey, mode);
    if (!change) return;
    e.preventDefault();
    if (change.kind === 'move') moveBy(event, change.days);
    else resizeTo(event, addDays(event.end, change.days));
  };

  const createOn = async (day: string) => {
    if (!firstEditable) return;
    try {
      const created = await api.records.create({
        params: { tableId: table.id },
        body: { fields: { [firstEditable.start.id]: valueOnDay(firstEditable.start, day) } },
      });
      await qc.invalidateQueries({ queryKey: queryKeys.records.table(table.id) });
      const id = 'records' in created ? created.records[0]?.id : created.id;
      if (id) onExpandRecord(id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't add the record");
    }
  };

  const [expandLayout, setExpandLayout] = useState<ExpandLayout>(() =>
    storedLayout(typeof window === 'undefined' ? undefined : window.localStorage)
  );
  const deleteRecord = useDeleteRecordWithUndo(table.id);
  const hintId = useId();

  const total = ranged.data?.total ?? 0;
  const loaded = ranged.data?.records.length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CalendarToolbar
        fields={fields}
        layout={layout}
        mode={mode}
        title={rangeTitle(mode, anchor)}
        onLayoutChange={saveLayout}
        onStep={(step) => setAnchor((a) => stepAnchor(mode, a, step))}
        onToday={() => setAnchor(localToday())}
        query={viewQuery.query}
        onQueryChange={(patch: SavedViewQuery) => viewQuery.change(patch)}
        search={search}
        onSearchChange={setSearch}
        undatedOpen={undatedOpen}
        onUndatedToggle={() => setUndatedOpen((o) => !o)}
        undatedCount={pairs.length > 0 ? (undated.data?.total ?? undefined) : undefined}
        count={
          pairs.length === 0 || ranged.isPending
            ? ''
            : `${total.toLocaleString()} ${total === 1 ? 'record' : 'records'}`
        }
      />
      <p id={hintId} className="sr-only">
        Enter opens the record.
        {canEdit
          ? ' Alt with the arrow keys moves it by a day or a week; Alt+Shift with Left or Right changes its end.'
          : ''}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {pairs.length === 0 ? (
        <CalendarSetup
          fields={dateFieldsOf(fields)}
          onPick={(id) => saveLayout({ dateFields: [{ startFieldId: id, endFieldId: null }] })}
        />
      ) : (
        <>
          <Legend pairs={pairs} colorField={colorField} />
          {total > loaded && (
            <p className="border-b border-border px-3 py-1.5 text-small text-text-2" role="status">
              Showing the first {loaded.toLocaleString()} of {total.toLocaleString()} records in
              this range. Filter the view or switch to a week to see the rest.
            </p>
          )}
          <div className="flex min-h-0 flex-1">
            <section
              ref={gridRef}
              aria-label={`Calendar, ${rangeTitle(mode, anchor)}`}
              className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-app"
            >
              <div
                className="sticky top-0 z-10 grid border-b border-border bg-app"
                style={{ gridTemplateColumns: `repeat(${weeks[0]?.length ?? 7}, minmax(0, 1fr))` }}
                aria-hidden
              >
                {(weeks[0] ?? []).map((day) => (
                  <div key={day} className="px-2 py-1 text-small font-medium text-text-2">
                    {mode === 'day'
                      ? dayLabel(day)
                      : WEEKDAYS[new Date(`${day}T00:00Z`).getUTCDay()]}
                  </div>
                ))}
              </div>
              <div className={cn('flex flex-col', mode !== 'month' && 'flex-1')}>
                {weeks.map((days, w) => (
                  <WeekRow
                    key={days[0]}
                    index={w}
                    days={days}
                    mode={mode}
                    month={anchor.slice(0, 7)}
                    today={today}
                    segments={layoutRow(events, days)}
                    overDay={overDay}
                    canEdit={canEdit && firstEditable !== undefined}
                    hintId={hintId}
                    titleOf={titleOf}
                    onDragOver={(e) => onRowDragOver(e, days)}
                    onDragLeave={() => setOverDay(null)}
                    onDrop={(e) => onRowDrop(e, days)}
                    onEventDragStart={(e, ev) => onEventDragStart(e, ev, days)}
                    onDragEnd={() => {
                      dragging.current = null;
                      setOverDay(null);
                    }}
                    onResizeStart={onResizeStart}
                    onEventKey={onEventKey}
                    onOpen={(ev) => onExpandRecord(ev.record.id)}
                    onCreate={(day) => void createOn(day)}
                    onShowDay={(day) => {
                      setAnchor(day);
                      saveLayout({ mode: 'day' });
                    }}
                  />
                ))}
              </div>
            </section>
            {undatedOpen && (
              <UndatedPanel
                records={undated.data?.records ?? []}
                total={undated.data?.total ?? 0}
                canEdit={canEdit && firstEditable !== undefined}
                titleOf={titleOf}
                onOpen={(r) => onExpandRecord(r.id)}
                onDragStart={(e, record) => {
                  dragging.current = { record };
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', titleOf(record));
                }}
                onDragEnd={() => {
                  dragging.current = null;
                  setOverDay(null);
                }}
                onSchedule={(record) =>
                  schedule(record, anchor < from || anchor > to ? from : anchor)
                }
                anchorLabel={dayLabel(anchor)}
                onClose={() => setUndatedOpen(false)}
              />
            )}
          </div>
        </>
      )}
      {expandedRecordId && (
        <RecordExpand
          key={expandedRecordId}
          table={table}
          fields={fields}
          hidden={[]}
          recordId={expandedRecordId}
          cached={undefined}
          index={null}
          total={0}
          userRole={role}
          canEdit={canEdit}
          layout={expandLayout}
          onLayoutChange={(l) => {
            setExpandLayout(l);
            storeLayout(window.localStorage, l);
          }}
          onNavigate={() => {}}
          onClose={() => onExpandRecord(null)}
          onDelete={deleteRecord}
        />
      )}
    </div>
  );
}

/** One row of days: the day cells, then the event segments laid over them in lanes. */
function WeekRow({
  index,
  days,
  mode,
  month,
  today,
  segments,
  overDay,
  canEdit,
  hintId,
  titleOf,
  onDragOver,
  onDragLeave,
  onDrop,
  onEventDragStart,
  onDragEnd,
  onResizeStart,
  onEventKey,
  onOpen,
  onCreate,
  onShowDay,
}: {
  index: number;
  days: string[];
  mode: CalendarMode;
  month: string;
  today: string;
  segments: Segment[];
  overDay: string | null;
  canEdit: boolean;
  hintId: string;
  titleOf: (record: RecordData) => string;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onEventDragStart: (e: DragEvent<HTMLElement>, event: CalendarEvent) => void;
  onDragEnd: () => void;
  onResizeStart: (e: PointerEvent<HTMLElement>, event: CalendarEvent) => void;
  onEventKey: (e: KeyboardEvent<HTMLElement>, event: CalendarEvent) => void;
  onOpen: (event: CalendarEvent) => void;
  onCreate: (day: string) => void;
  onShowDay: (day: string) => void;
}) {
  const limited = mode === 'month';
  const lanes = segments.reduce((n, s) => Math.max(n, s.lane + 1), 0);
  const shown = limited && lanes > MONTH_LANES + 1 ? MONTH_LANES : lanes;
  const visible = segments.filter((s) => s.lane < shown);
  const hiddenPerDay = days.map(
    (_, col) =>
      segments.filter((s) => s.lane >= shown && s.col <= col && col < s.col + s.span).length
  );
  const height = limited
    ? DAY_HEADER + (MONTH_LANES + 1) * LANE + 8
    : Math.max(DAY_HEADER + lanes * LANE + 40, 320);
  const columns = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop target; the keyboard moves events
    <div
      data-week={index}
      data-days={days.join(',')}
      className={cn('relative grid border-b border-border', !limited && 'flex-1')}
      style={{ ...columns, minHeight: height }}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDragLeave();
      }}
      onDrop={onDrop}
    >
      {days.map((day, col) => {
        const outside = mode === 'month' && day.slice(0, 7) !== month;
        const hidden = hiddenPerDay[col] ?? 0;
        return (
          <div
            key={day}
            data-day={day}
            className={cn(
              'group relative border-r border-border last:border-r-0',
              outside && 'bg-hover/40',
              overDay === day && 'bg-selected'
            )}
          >
            <div className="flex h-7 items-center justify-between px-1.5">
              <span
                className={cn(
                  'tnum inline-flex size-6 items-center justify-center rounded-full text-small',
                  outside ? 'text-text-3' : 'text-text-2',
                  day === today && 'bg-primary font-semibold text-primary-foreground'
                )}
              >
                {Number(day.slice(8, 10))}
              </span>
              {canEdit && (
                <button
                  type="button"
                  aria-label={`New record on ${dayLabel(day)}`}
                  onClick={() => onCreate(day)}
                  className="inline-flex size-6 items-center justify-center rounded-sm text-text-2 opacity-0 hover:bg-hover focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Plus className="size-3.5" aria-hidden />
                </button>
              )}
            </div>
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => onShowDay(day)}
                className="absolute left-1.5 text-small text-text-2 hover:text-text hover:underline"
                style={{ top: DAY_HEADER + MONTH_LANES * LANE + 2 }}
              >
                +{hidden} more
              </button>
            )}
          </div>
        );
      })}
      {visible.map((s) => (
        <EventBar
          key={s.event.key}
          segment={s}
          columns={days.length}
          canEdit={canEdit}
          hintId={hintId}
          title={titleOf(s.event.record)}
          onDragStart={(e) => onEventDragStart(e, s.event)}
          onDragEnd={onDragEnd}
          onResizeStart={(e) => onResizeStart(e, s.event)}
          onKeyDown={(e) => onEventKey(e, s.event)}
          onOpen={() => onOpen(s.event)}
        />
      ))}
    </div>
  );
}

function EventBar({
  segment,
  columns,
  canEdit,
  hintId,
  title,
  onDragStart,
  onDragEnd,
  onResizeStart,
  onKeyDown,
  onOpen,
}: {
  segment: Segment;
  columns: number;
  canEdit: boolean;
  hintId: string;
  title: string;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onResizeStart: (e: PointerEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onOpen: () => void;
}) {
  const { event, col, span, lane } = segment;
  const movable = canEdit && event.movable;
  const when =
    event.end !== event.start
      ? `${dayLabel(event.start)} to ${dayLabel(event.end)}`
      : dayLabel(event.start);
  return (
    // biome-ignore lint/a11y/useSemanticElements: Chromium starts no native drag from a button
    <div
      role="button"
      tabIndex={0}
      draggable={movable}
      data-event-key={event.key}
      data-event-start={event.start}
      aria-label={`${title}, ${when}${event.time ? ` at ${event.time}` : ''}`}
      aria-describedby={hintId}
      aria-keyshortcuts={
        movable ? 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' : undefined
      }
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      className={cn(
        'absolute flex h-[22px] items-center gap-1 overflow-hidden rounded-sm px-1.5 text-small shadow-1 outline-none focus-visible:shadow-[0_0_0_2px_var(--brand)]',
        movable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        segment.continuesBefore && 'rounded-l-none',
        segment.continuesAfter && 'rounded-r-none'
      )}
      style={{
        ...chipStyle(event.color),
        top: DAY_HEADER + lane * LANE,
        left: `calc(${(col / columns) * 100}% + 4px)`,
        width: `calc(${(span / columns) * 100}% - 8px)`,
      }}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: `var(--chip-${event.color})` }}
      />
      {event.time && <span className="tnum shrink-0 opacity-80">{event.time}</span>}
      <span className="truncate">{title}</span>
      {movable && event.resizable && !segment.continuesAfter && (
        <span
          aria-hidden
          data-resize-handle
          onPointerDown={onResizeStart}
          onClick={(e) => e.stopPropagation()}
          className="absolute top-0 right-0 h-full w-2 cursor-ew-resize"
        />
      )}
    </div>
  );
}

/** The legend: each date field pair's colour, or the colour field's choices. */
function Legend({ pairs, colorField }: { pairs: DatePair[]; colorField: FieldMeta | undefined }) {
  const items: { key: string; label: string; color: ChoiceColor }[] = colorField
    ? choicesOf(colorField).map((c) => ({ key: c.id, label: c.name, color: c.color }))
    : pairs.map((p) => ({
        key: p.start.id,
        label: p.end ? `${p.start.name} – ${p.end.name}` : p.start.name,
        color: p.color,
      }));
  return (
    <ul
      aria-label={colorField ? `Colours: ${colorField.name}` : 'Date fields'}
      className="flex h-8 shrink-0 items-center gap-3 overflow-x-auto border-b border-border px-3 text-small text-text-2"
    >
      {items.map((i) => (
        <li key={i.key} className="flex items-center gap-1.5 whitespace-nowrap">
          <span
            aria-hidden
            className="size-2 rounded-full"
            style={{ background: `var(--chip-${i.color})` }}
          />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Records without a start date: open one, drag it onto a day, or schedule it on the anchor. */
function UndatedPanel({
  records,
  total,
  canEdit,
  titleOf,
  onOpen,
  onDragStart,
  onDragEnd,
  onSchedule,
  anchorLabel,
  onClose,
}: {
  records: RecordData[];
  total: number;
  canEdit: boolean;
  titleOf: (record: RecordData) => string;
  onOpen: (record: RecordData) => void;
  onDragStart: (e: DragEvent<HTMLElement>, record: RecordData) => void;
  onDragEnd: () => void;
  onSchedule: (record: RecordData) => void;
  anchorLabel: string;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Undated records"
      className="flex w-72 shrink-0 flex-col border-l border-border bg-surface"
    >
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <h3 className="font-semibold">Undated ({total.toLocaleString()})</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      {records.length === 0 ? (
        <p className="p-3 text-text-2">Every record has a date.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {records.map((r) => (
            <li
              key={r.id}
              draggable={canEdit}
              onDragStart={(e) => onDragStart(e, r)}
              onDragEnd={onDragEnd}
              className={cn(
                'group flex h-8 items-center gap-1 rounded-sm px-1 hover:bg-hover',
                canEdit && 'cursor-grab'
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => onOpen(r)}
              >
                {titleOf(r)}
              </button>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Schedule ${titleOf(r)} on ${anchorLabel}`}
                  title={`Schedule on ${anchorLabel}`}
                  onClick={() => onSchedule(r)}
                  className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <CalendarDays className="size-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
          {total > records.length && (
            <li className="px-1 py-2 text-small text-text-2">
              {(total - records.length).toLocaleString()} more; filter the view to find them.
            </li>
          )}
        </ul>
      )}
    </aside>
  );
}

/** Before any date field is chosen: pick the one records sit on. */
function CalendarSetup({ fields, onPick }: { fields: FieldMeta[]; onPick: (id: string) => void }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-app p-6">
      <div className="max-w-sm rounded-md border border-border bg-surface p-5 shadow-1">
        <h2 className="mb-1 font-semibold">Choose a date field</h2>
        {fields.length === 0 ? (
          <p className="text-text-2">
            This table has no date fields. Add a date field to see its records on a calendar.
          </p>
        ) : (
          <>
            <p className="mb-3 text-text-2">Records sit on the calendar by this field.</p>
            <ul className="grid gap-1">
              {fields.map((f) => (
                <li key={f.id}>
                  <Button
                    variant="secondary"
                    className="w-full justify-start"
                    onClick={() => onPick(f.id)}
                  >
                    {f.name}
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
