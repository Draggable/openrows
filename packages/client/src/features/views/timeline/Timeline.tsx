import {
  type RecordData,
  type SavedViewQuery,
  type TableMeta,
  TIMELINE_SCALES,
  type TimelineLayout,
  type TimelineScale,
  type UserRole,
  type ViewMeta,
  type ViewQuery,
} from '@openrows/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronLeft, ChevronRight, GanttChart, Settings2 } from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { ApiError, api } from '../../../api/client';
import { queryKeys } from '../../../api/keys';
import { recordQueries, useUpdateView } from '../../../api/queries';
import { Button, Popover, PopoverContent, PopoverTrigger, toast } from '../../../components/ui';
import { MOBILE_QUERY, useMediaQuery } from '../../../lib/media';
import { cn } from '../../../lib/utils';
import { ChoiceChip, chipStyle } from '../../grid/cells/CellContent';
import { cellText, choicesOf } from '../../grid/cells/model';
import { type ExpandLayout, storedLayout, storeLayout } from '../../record/model';
import { RecordExpand, useDeleteRecordWithUndo } from '../../record/RecordExpand';
import { canConfigureView } from '../access';
import {
  addDays,
  type CalendarEvent,
  dateFieldsOf,
  dayLabel,
  daysBetween,
  localToday,
  movePatch,
  resizePatch,
} from '../calendar/model';
import { FieldSelect, LayoutToolbar } from '../toolbar/LayoutToolbar';
import { useDebounced, useViewQuery } from '../toolbar/useViewQuery';
import {
  barBox,
  dependenciesOf,
  dependencyPath,
  rowsOf,
  SCALES,
  selfLinksOf,
  singleSelectsOf,
  startResizePatch,
  ticksOf,
  timelinePair,
  titlePlacement,
  windowOf,
} from './model';

const QUERY_DELAY = 250;
const RANGE_LIMIT = 1000;
const ROW = 34;
const HEADER = 48;
const LABEL_WIDTH = 240;
/** Phones: the record names give the bars most of the screen. */
const PHONE_LABEL_WIDTH = 120;
const SCALE_LABELS: Record<TimelineScale, string> = { day: 'Day', week: 'Week', month: 'Month' };

type DragMode = 'move' | 'start' | 'end';
type Drag = { event: CalendarEvent; mode: DragMode; x0: number; days: number };

/**
 * The timeline view: a record per row, as a bar from its start to its end date on a
 * horizontal time axis, zoomed by day, week or month. Only the visible window is fetched (the
 * calendar's `dateRange`). Rows group under the choices of a single select; bars take
 * the colour of another. Dragging a bar moves it, dragging its edges resizes it (through the
 * RecordService); Alt+arrow keys do the same from the keyboard. With a dependency field (a link
 * to the same table) it is a Gantt chart: arrows from the records a record waits for, in red
 * when the record starts before they end.
 */
export function Timeline({
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

  const updateView = useUpdateView(table.id);
  const [localLayout, setLocalLayout] = useState<TimelineLayout>({});
  const saved = view?.config.timeline;
  const layout: TimelineLayout = useMemo(
    () => ({ ...saved, ...localLayout }),
    [saved, localLayout]
  );
  const saveLayout = (patch: TimelineLayout) => {
    setLocalLayout((l) => ({ ...l, ...patch }));
    if (!canConfigure || !view) return;
    updateView.mutate(
      { viewId: view.id, timeline: patch },
      { onError: () => toast.error("Couldn't save the timeline's settings") }
    );
  };
  const scale: TimelineScale = layout.scale ?? 'week';
  const { px, days, step } = SCALES[scale];
  const dateFields = dateFieldsOf(fields);
  const pair = useMemo(
    () => timelinePair(fields, layout, (f) => dateFields.some((d) => d.id === f.id)),
    [fields, layout, dateFields]
  );
  const selects = singleSelectsOf(fields);
  const groupField = selects.find((f) => f.id === layout.groupFieldId);
  const colorField = selects.find((f) => f.id === layout.colorFieldId);
  const links = selfLinksOf(fields, table.id);
  const dependencyField = links.find((f) => f.id === layout.dependencyFieldId);

  const [anchor, setAnchor] = useState(() => localToday());
  const today = localToday();
  const { from, to } = windowOf(scale, anchor);

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
  const ranged = useQuery({
    ...recordQueries.query(table.id, {
      viewId,
      query: {
        ...applied,
        dateRange: {
          from,
          to,
          fields: pair ? [{ startFieldId: pair.start.id, endFieldId: pair.end?.id ?? null }] : [],
        },
      },
      limit: RANGE_LIMIT,
      count: true,
    }),
    enabled: pair !== null,
  });

  // Edits in flight show at once; the refetch replaces them.
  const [pending, setPending] = useState<Map<string, Record<string, unknown>>>(new Map());
  const records = useMemo(() => {
    const loaded = ranged.data?.records ?? [];
    if (pending.size === 0) return loaded;
    return loaded.map((r) => {
      const patch = pending.get(r.id);
      return patch ? { ...r, fields: { ...r.fields, ...patch } } : r;
    });
  }, [ranged.data, pending]);
  const rows = useMemo(
    () => (pair ? rowsOf(records, pair, colorField, groupField) : []),
    [records, pair, colorField, groupField]
  );
  const bars = rows.flatMap((r) => (r.kind === 'bar' ? [r.event] : []));
  const rowOf = new Map(rows.flatMap((r, i) => (r.kind === 'bar' ? [[r.event.record.id, i]] : [])));
  const deps = dependenciesOf(bars, dependencyField);
  // Bars an arrow leaves from: a title beside one starts past the arrow's first step.
  const waitedFor = new Set(deps.map((d) => d.from));

  const [announcement, setAnnouncement] = useState('');
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
  const apply = (event: CalendarEvent, mode: DragMode, n: number) => {
    if (!canEdit || n === 0) return;
    const title = titleOf(event.record);
    if (mode === 'move') {
      const patch = movePatch(event, n);
      if (patch)
        void save(event.record, patch, `Moved ${title} to ${dayLabel(addDays(event.start, n))}.`);
    } else if (mode === 'end') {
      const patch = resizePatch(event, addDays(event.end, n));
      if (patch)
        void save(event.record, patch, `${title} now ends ${dayLabel(addDays(event.end, n))}.`);
    } else {
      const patch = startResizePatch(event, addDays(event.start, n));
      if (patch) {
        void save(event.record, patch, `${title} now starts ${dayLabel(addDays(event.start, n))}.`);
      }
    }
  };

  // Pointer drags: the bar or its edges follow the pointer by whole days.
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const moved = useRef(false);
  const onBarPointerDown = (e: PointerEvent, event: CalendarEvent, mode: DragMode) => {
    if (!canEdit || !event.movable || e.button !== 0) return;
    if (mode !== 'move' && !event.resizable) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const d = { event, mode, x0: e.clientX, days: 0 };
    dragRef.current = d;
    moved.current = false;
    setDrag(d);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const n = Math.round((e.clientX - d.x0) / px);
    if (Math.abs(e.clientX - d.x0) > 3) moved.current = true;
    if (n !== d.days) {
      const next = { ...d, days: n };
      dragRef.current = next;
      setDrag(next);
    }
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (d && d.days !== 0) apply(d.event, d.mode, d.days);
  };
  const shown = (event: CalendarEvent): { start: string; end: string } => {
    if (!drag || drag.event.key !== event.key) return event;
    const n = drag.days;
    if (drag.mode === 'move') return { start: addDays(event.start, n), end: addDays(event.end, n) };
    if (drag.mode === 'end') {
      const end = addDays(event.end, n);
      // Days compare as text; a range never ends before it starts.
      return { start: event.start, end: [event.start, end].sort()[1] ?? end };
    }
    const start = addDays(event.start, n);
    return { start: [start, event.end].sort()[0] ?? start, end: event.end };
  };

  // Rows, virtualized.
  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 8,
    paddingStart: HEADER,
  });
  // How far the canvas is scrolled under the sticky label column: arrows are clipped there. It
  // is updated before the paint (on scroll with flushSync, as the virtualizer does), so a frame
  // never shows the arrows clipped at the previous scroll, under the labels.
  const [scrollLeft, setScrollLeft] = useState(0);
  const labelWidth = useMediaQuery(MOBILE_QUERY) ? PHONE_LABEL_WIDTH : LABEL_WIDTH;
  // Scroll today (or the anchor) into view when the window changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on window changes only
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const col = Math.max(0, daysBetween(from, anchor) - 3);
    el.scrollLeft = col * px;
    setScrollLeft(el.scrollLeft);
  }, [from, scale]);

  // Keyboard: one bar in the tab order; arrows move between bars, Alt+arrows move the bar.
  const [active, setActive] = useState<string | null>(null);
  const focusTarget = useRef<string | null>(null);
  useEffect(() => {
    const id = focusTarget.current;
    if (!id) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-bar-id="${id}"]`);
    if (el) {
      focusTarget.current = null;
      el.focus();
    }
  });
  const keyStep = scale === 'day' ? 1 : 7;
  const onBarKey = (e: KeyboardEvent, event: CalendarEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onExpandRecord(event.record.id);
      return;
    }
    const horizontal = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (e.altKey && horizontal) {
      e.preventDefault();
      focusTarget.current = event.record.id;
      apply(event, e.shiftKey ? 'end' : 'move', horizontal * keyStep);
      return;
    }
    const vertical = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!vertical) return;
    const at = bars.findIndex((b) => b.key === event.key);
    const next = bars[at + vertical];
    if (!next) return;
    e.preventDefault();
    const row = rowOf.get(next.record.id);
    if (row !== undefined) v.scrollToIndex(row, { align: 'auto' });
    setActive(next.record.id);
    focusTarget.current = next.record.id;
  };

  const [expandLayout, setExpandLayout] = useState<ExpandLayout>(() =>
    storedLayout(typeof window === 'undefined' ? undefined : window.localStorage)
  );
  const deleteRecord = useDeleteRecordWithUndo(table.id);
  const hintId = useId();
  const ticks = ticksOf(scale, from, days);
  const total = ranged.data?.total ?? 0;
  const width = labelWidth + days * px;
  const todayCol = daysBetween(from, today);
  const firstBar = bars[0]?.record.id;
  const tabbable = active && rowOf.has(active) ? active : firstBar;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LayoutToolbar
        fields={fields}
        query={viewQuery.query}
        onQueryChange={(patch: SavedViewQuery) => viewQuery.change(patch)}
        search={search}
        onSearchChange={setSearch}
        sortable={false}
        count={
          pair && !ranged.isPending
            ? `${total.toLocaleString()} ${total === 1 ? 'record' : 'records'}`
            : ''
        }
      >
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm">
              <Settings2 className="size-4 text-text-2" aria-hidden />
              Timeline settings
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80" aria-label="Timeline settings">
            <FieldSelect
              label="Start date"
              value={pair?.start.id}
              fields={dateFields}
              none={pair ? false : 'Pick a field'}
              onChange={(id) => saveLayout({ startFieldId: id })}
            />
            <FieldSelect
              label="End date"
              value={pair?.end?.id}
              fields={dateFields.filter((f) => f.id !== pair?.start.id)}
              onChange={(id) => saveLayout({ endFieldId: id })}
            />
            <FieldSelect
              label="Group by"
              value={groupField?.id}
              fields={selects}
              onChange={(id) => saveLayout({ groupFieldId: id })}
            />
            <FieldSelect
              label="Colour by"
              value={colorField?.id}
              fields={selects}
              onChange={(id) => saveLayout({ colorFieldId: id })}
            />
            <FieldSelect
              label="Dependencies (Gantt)"
              value={dependencyField?.id}
              fields={links}
              onChange={(id) => saveLayout({ dependencyFieldId: id })}
            />
            {links.length === 0 && (
              <p className="text-small text-text-3">
                Add a link field to this table's own records to draw dependencies.
              </p>
            )}
          </PopoverContent>
        </Popover>
        <fieldset className="flex items-center gap-0.5" aria-label="Zoom">
          {TIMELINE_SCALES.map((s) => (
            <Button
              key={s}
              variant="ghost"
              size="sm"
              aria-pressed={s === scale}
              className={cn(s === scale && 'bg-selected text-text')}
              onClick={() => saveLayout({ scale: s })}
            >
              {SCALE_LABELS[s]}
            </Button>
          ))}
        </fieldset>
        <Button variant="ghost" size="sm" onClick={() => setAnchor(today)}>
          Today
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Earlier"
          onClick={() => setAnchor((a) => addDays(a, -step))}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Later"
          onClick={() => setAnchor((a) => addDays(a, step))}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </LayoutToolbar>
      <p id={hintId} className="sr-only">
        Enter opens the record. Up and down arrows move between bars.
        {canEdit ? ' Alt with Left or Right moves the bar; add Shift to change its end.' : ''}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {!pair ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <GanttChart className="size-6 text-text-3" aria-hidden />
          <h2 className="text-[15px] font-[550]">Place records on a timeline by a date field</h2>
          {dateFields.length === 0 ? (
            <p className="max-w-sm text-text-2">Add a date field to this table first.</p>
          ) : (
            <div className="flex flex-wrap justify-center gap-2">
              {dateFields.map((f) => (
                <Button
                  key={f.id}
                  variant="secondary"
                  size="sm"
                  onClick={() => saveLayout({ startFieldId: f.id })}
                >
                  Start on {f.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <section
          ref={scrollRef}
          aria-label="Timeline"
          className="relative min-h-0 flex-1 overflow-auto bg-app"
          onScroll={(e) => {
            const left = e.currentTarget.scrollLeft;
            if (left !== scrollLeft) flushSync(() => setScrollLeft(left));
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="relative" style={{ width, height: v.getTotalSize() }}>
            {/* The axis: months (or years) above days (or weeks, or months). */}
            <div
              className="sticky top-0 z-20 flex border-b border-border bg-header"
              style={{ height: HEADER, width }}
              aria-hidden
            >
              <div
                className="sticky left-0 z-10 shrink-0 border-r border-border bg-header"
                style={{ width: labelWidth }}
              />
              <div className="relative flex-1">
                {ticks.top.map((t) => (
                  <span
                    key={`t${t.day}`}
                    className="absolute top-0 h-6 truncate border-l border-border px-1.5 text-small leading-6 font-[550] text-text-2"
                    style={{ left: t.offset * px }}
                  >
                    {t.label}
                  </span>
                ))}
                {ticks.bottom.map((t) => (
                  <span
                    key={`b${t.day}`}
                    data-day={t.day}
                    className={cn(
                      'tnum absolute top-6 h-6 overflow-hidden border-l border-border px-1 text-small leading-6 text-text-2',
                      t.day === today && 'font-[550] text-primary'
                    )}
                    style={{ left: t.offset * px }}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
            {todayCol >= 0 && todayCol < days && (
              <div
                aria-hidden
                className="pointer-events-none absolute z-0 w-px bg-primary/60"
                style={{ left: labelWidth + todayCol * px + px / 2, top: HEADER, bottom: 0 }}
              />
            )}
            {/* biome-ignore lint/a11y/useSemanticElements: virtualized rows are positioned divs */}
            <div role="list" aria-label="Records on the timeline">
              {v.getVirtualItems().map((item) => {
                const row = rows[item.index];
                if (!row) return null;
                const style = { transform: `translateY(${item.start}px)`, height: ROW, width };
                if (row.kind === 'group') {
                  const choice = groupField
                    ? choicesOf(groupField).find((c) => c.id === row.key)
                    : undefined;
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: virtualized rows are positioned divs
                    <div
                      key={`g${row.key}`}
                      role="listitem"
                      className="absolute top-0 left-0 flex items-center border-b border-border bg-sidebar"
                      style={style}
                    >
                      <h3
                        className="sticky left-0 flex items-center gap-2 px-3"
                        style={{ width: labelWidth }}
                      >
                        {choice ? (
                          <ChoiceChip choice={choice} />
                        ) : (
                          <span className="font-[550] text-text-2">{row.label}</span>
                        )}
                        <span className="tnum text-small text-text-3">{row.count}</span>
                      </h3>
                    </div>
                  );
                }
                const event = row.event;
                const box = barBox(shown(event), from, days, px);
                const title = titleOf(event.record);
                const when =
                  event.start === event.end
                    ? dayLabel(event.start)
                    : `${dayLabel(event.start)} to ${dayLabel(event.end)}`;
                const movable = canEdit && event.movable;
                // A title beside its bar; not when the bar is scrolled under the labels.
                const gap = waitedFor.has(event.record.id) ? 14 : 6;
                const outside =
                  box &&
                  titlePlacement(title, box, days * px, gap) === 'outside' &&
                  box.left + box.width > scrollLeft;
                return (
                  // biome-ignore lint/a11y/useSemanticElements: virtualized rows are positioned divs
                  <div
                    key={event.key}
                    role="listitem"
                    className="absolute top-0 left-0 flex border-b border-border/60"
                    style={style}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => onExpandRecord(event.record.id)}
                      className="sticky left-0 z-10 shrink-0 truncate border-r border-border bg-app px-3 text-left hover:bg-hover"
                      style={{ width: labelWidth }}
                    >
                      {title}
                    </button>
                    <div className="relative flex-1">
                      {box && (
                        // biome-ignore lint/a11y/useSemanticElements: a draggable bar with resize handles
                        <div
                          role="button"
                          tabIndex={tabbable === event.record.id ? 0 : -1}
                          data-bar-id={event.record.id}
                          data-start={event.start}
                          data-end={event.end}
                          aria-label={`${title}, ${when}`}
                          aria-describedby={hintId}
                          aria-keyshortcuts={
                            movable
                              ? 'Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowRight'
                              : undefined
                          }
                          onFocus={() => setActive(event.record.id)}
                          onKeyDown={(e) => onBarKey(e, event)}
                          onPointerDown={(e) => onBarPointerDown(e, event, 'move')}
                          onClick={() => {
                            if (!moved.current) onExpandRecord(event.record.id);
                            moved.current = false;
                          }}
                          className={cn(
                            'absolute top-[6px] z-[1] flex h-[22px] touch-none items-center overflow-hidden rounded-sm px-1.5 text-small shadow-1 outline-none select-none focus-visible:shadow-[0_0_0_2px_var(--brand)]',
                            movable ? 'cursor-grab' : 'cursor-pointer',
                            drag?.event.key === event.key && 'cursor-grabbing opacity-90',
                            box.clippedStart && 'rounded-l-none',
                            box.clippedEnd && 'rounded-r-none'
                          )}
                          style={{ ...chipStyle(event.color), left: box.left, width: box.width }}
                        >
                          {!outside && <span className="truncate">{title}</span>}
                          {movable && event.resizable && !box.clippedStart && (
                            <span
                              aria-hidden
                              data-resize="start"
                              onPointerDown={(e) => onBarPointerDown(e, event, 'start')}
                              className="absolute top-0 left-0 h-full w-2 cursor-ew-resize"
                            />
                          )}
                          {movable && event.resizable && !box.clippedEnd && (
                            <span
                              aria-hidden
                              data-resize="end"
                              onPointerDown={(e) => onBarPointerDown(e, event, 'end')}
                              className="absolute top-0 right-0 h-full w-2 cursor-ew-resize"
                            />
                          )}
                        </div>
                      )}
                      {box && outside && (
                        <span
                          aria-hidden
                          data-testid="bar-title-outside"
                          className="pointer-events-none absolute top-[6px] flex h-[22px] items-center whitespace-nowrap text-small text-text-2"
                          style={{ left: box.left + box.width + gap }}
                        >
                          {title}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {deps.length > 0 && (
              <DependencyLines
                deps={deps}
                bars={bars}
                rowOf={rowOf}
                rowTop={(i) => HEADER + i * ROW}
                xOf={(e) => {
                  const s = shown(e);
                  return {
                    start: daysBetween(from, s.start) * px,
                    end: (daysBetween(from, s.end) + 1) * px,
                  };
                }}
                left={labelWidth}
                visibleFrom={scrollLeft}
                width={days * px}
                height={v.getTotalSize()}
              />
            )}
          </div>
          {rows.length === 0 && !ranged.isPending && (
            <p className="absolute inset-x-0 py-12 text-center text-text-3" style={{ top: HEADER }}>
              No records in these dates
            </p>
          )}
        </section>
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

/** The Gantt arrows: from the end of the bar a record waits for to the start of its own. */
function DependencyLines({
  deps,
  bars,
  rowOf,
  rowTop,
  xOf,
  left,
  visibleFrom,
  width,
  height,
}: {
  deps: ReturnType<typeof dependenciesOf>;
  bars: CalendarEvent[];
  rowOf: Map<string, number>;
  rowTop: (row: number) => number;
  /** A bar's start and end on the canvas (px), outside the window too. */
  xOf: (e: CalendarEvent) => { start: number; end: number };
  left: number;
  /** The canvas x the label column ends at (how far it is scrolled). */
  visibleFrom: number;
  width: number;
  height: number;
}) {
  const id = `dep${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const byId = new Map(bars.map((b) => [b.record.id, b]));
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute top-0 z-[2] overflow-hidden"
      style={{ left, width, height }}
    >
      <defs>
        {(['ok', 'conflict'] as const).map((kind) => (
          <marker
            key={kind}
            id={`${id}-${kind}`}
            viewBox="0 0 6 6"
            refX="6"
            refY="3"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path
              d="M0,0 L6,3 L0,6 z"
              className={kind === 'conflict' ? 'fill-danger' : 'fill-text-3'}
            />
          </marker>
        ))}
      </defs>
      {deps.map((d) => {
        const a = byId.get(d.from);
        const b = byId.get(d.to);
        const ra = rowOf.get(d.from);
        const rb = rowOf.get(d.to);
        if (!a || !b || ra === undefined || rb === undefined) return null;
        // Never over the label column, nothing when both ends are out of sight.
        const path = dependencyPath(
          xOf(a).end,
          rowTop(ra) + ROW / 2,
          xOf(b).start,
          rowTop(rb) + ROW / 2,
          visibleFrom,
          width
        );
        if (!path) return null;
        return (
          <path
            key={`${d.from}-${d.to}`}
            data-testid="dependency"
            data-from={d.from}
            data-to={d.to}
            data-conflict={d.conflict}
            d={path.d}
            fill="none"
            strokeWidth={1.5}
            markerEnd={path.arrow ? `url(#${id}-${d.conflict ? 'conflict' : 'ok'})` : undefined}
            className={d.conflict ? 'stroke-danger' : 'stroke-text-3'}
          />
        );
      })}
    </svg>
  );
}
