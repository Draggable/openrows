import {
  type CalendarMode,
  type Choice,
  downloads,
  type FieldMeta,
  isCalendarDateField,
  type RecordData,
  SHARED_LAYOUT_MAX_RECORDS,
  type SharedRecord,
  type SharedView,
  type TimelineScale,
} from '@openrows/shared';
import { type UseQueryOptions, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { downloadUrl } from '../../api/client';
import { shareQueries } from '../../api/queries';
import { Button, Skeleton } from '../../components/ui';
import { cn } from '../../lib/utils';
import { ChoiceChip, chipStyle } from '../grid/cells/CellContent';
import { cellText, choicesOf } from '../grid/cells/model';
import {
  addDays,
  type DatePair,
  datePairsOf,
  dayLabel,
  eventsOf,
  layoutRow,
  localToday,
  rangeTitle,
  stepAnchor,
  visibleWeeks,
  WEEKDAYS,
} from '../views/calendar/model';
import { CARD_SIZES } from '../views/gallery/model';
import { CARD, coverOf } from '../views/kanban/model';
import { listRows } from '../views/list/model';
import {
  barBox,
  dependenciesOf,
  dependencyPath,
  SCALES,
  ticksOf,
  timelinePair,
  rowsOf as timelineRowsOf,
  windowOf,
} from '../views/timeline/model';
import { asFieldMeta, SharedCell } from './SharedCell';

/**
 * The public, read-only kanban, calendar, gallery, timeline and list views of a share link
 * . They draw with the app views' models (stacks, events and lanes, bars and dependency
 * arrows, the list's tree) over what the link's API answers: only the fields the layout shows
 * (`SharedView`), the records its filter keeps, links and people as names, files through the
 * link, and a timeline's dependencies or a list's parents as ids of records the view shows.
 * Nothing here edits, drags or opens a record. The page loads up to SHARED_LAYOUT_MAX_RECORDS
 * records (calendars and timelines per date window).
 */
export function SharedLayout({
  token,
  viewId,
  shared,
  records,
}: {
  /** The share link's token, for files; null (an interface page): files by name only. */
  token: string | null;
  viewId: string;
  shared: SharedView;
  /** Where the records come from; a share link's records route by default. */
  records?: LayoutRecordsSource | undefined;
}) {
  const fields = useMemo(() => shared.fields.map(asFieldMeta), [shared.fields]);
  const source =
    records ??
    // The share link's query keys are narrower than a source's; its data is the same.
    (((window: { from: string; to: string } | null) =>
      shareQueries.layoutRecords(token ?? '', viewId, window)) as unknown as LayoutRecordsSource);
  const ctx: LayoutContext = { token, viewId, shared, fields, source };
  switch (shared.view.type) {
    case 'kanban':
      return <SharedKanban ctx={ctx} />;
    case 'gallery':
      return <SharedGallery ctx={ctx} />;
    case 'list':
      return <SharedList ctx={ctx} />;
    case 'calendar':
      return <SharedCalendar ctx={ctx} />;
    case 'timeline':
      return <SharedTimeline ctx={ctx} />;
    default:
      return <p className="p-6 text-center text-text-2">This view can’t be shown here.</p>;
  }
}

/** The records of a layout, optionally in a date window: the query that loads them. */
export type LayoutRecordsSource = (
  window: { from: string; to: string } | null
) => UseQueryOptions<
  { records: SharedRecord[]; total: number },
  Error,
  { records: SharedRecord[]; total: number },
  readonly unknown[]
>;

interface LayoutContext {
  token: string | null;
  viewId: string;
  shared: SharedView;
  fields: FieldMeta[];
  source: LayoutRecordsSource;
}

/** The record as the app's view models read it; self links (`links`) as `{ id }` items. */
function asRecord(r: SharedRecord): RecordData {
  const fields: Record<string, unknown> = { ...r.fields };
  for (const [id, ids] of Object.entries(r.links ?? {})) {
    fields[id] = ids.map((x) => ({ id: x, name: '' }));
  }
  return {
    id: r.id,
    tableId: '',
    version: 0,
    fields,
    createdAt: '',
    createdBy: null,
    updatedAt: '',
    updatedBy: null,
  };
}

/** A structural self-link field (a list's parents, a timeline's dependencies) for the models. */
const linkStub = (id: string): FieldMeta =>
  asFieldMeta({ id, name: '', type: 'link', options: {}, isPrimary: false });

function useLayoutRecords(ctx: LayoutContext, window: { from: string; to: string } | null) {
  return useQuery(ctx.source(window));
}

const titleOf = (primary: FieldMeta | undefined, record: SharedRecord) =>
  (primary ? cellText(primary, record.fields[primary.id] ?? null) : '') || 'Unnamed record';

/** The bottom bar: the count, and a note when the page shows only the first records. */
function CountBar({ total, shown, extra }: { total: number; shown: number; extra?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-t border-border bg-header px-4 text-small text-text-2">
      <span>
        {total.toLocaleString()} record{total === 1 ? '' : 's'}
      </span>
      {shown < total && (
        <span>Showing the first {Math.min(shown, SHARED_LAYOUT_MAX_RECORDS).toLocaleString()}</span>
      )}
      {extra}
    </div>
  );
}

function Loading() {
  return (
    <div className="grid gap-2 p-4">
      <Skeleton className="h-8" />
      <Skeleton className="h-8" />
      <Skeleton className="h-8" />
    </div>
  );
}

function Failed() {
  return (
    <p role="alert" className="p-6 text-center text-text-2">
      Couldn’t load this view. Try again in a moment.
    </p>
  );
}

/** A card's or tile's cover: the first image of the cover field, through the link. */
function Cover({
  ctx,
  record,
  field,
  height,
  fit = 'crop',
}: {
  ctx: LayoutContext;
  record: SharedRecord;
  field: FieldMeta | undefined;
  height: number;
  fit?: 'crop' | 'fit';
}) {
  if (!field) return null;
  const cover = ctx.token === null ? null : coverOf(record.fields[field.id]);
  return (
    <div className="mb-2 shrink-0 overflow-hidden rounded-sm bg-header" style={{ height }}>
      {cover && (
        <img
          src={downloadUrl(downloads.sharedAttachmentThumbnail, {
            params: { shareToken: ctx.token ?? '', viewId: ctx.viewId, attachmentId: cover.id },
          })}
          alt={cover.filename}
          loading="lazy"
          className={cn('size-full', fit === 'fit' ? 'object-contain' : 'object-cover')}
        />
      )}
    </div>
  );
}

/**
 * A scroll container of read-only content: focusable so keyboard users can scroll it (axe's
 * scrollable-region-focusable), named as a region, or as a group inside one (a kanban stack).
 */
function ScrollRegion({
  label,
  group = false,
  className,
  children,
}: {
  label: string;
  group?: boolean;
  className: string;
  children: ReactNode;
}) {
  const Tag = group ? 'div' : 'section';
  return (
    <Tag role={group ? 'group' : undefined} aria-label={label} tabIndex={0} className={className}>
      {children}
    </Tag>
  );
}

/** A card: cover, title and the card fields (labelled for screen readers). */
function Card({
  ctx,
  record,
  primary,
  fields,
  cover,
  coverHeight,
  fit,
  labels = false,
}: {
  ctx: LayoutContext;
  record: SharedRecord;
  primary: FieldMeta | undefined;
  fields: FieldMeta[];
  cover: FieldMeta | undefined;
  coverHeight: number;
  fit?: 'crop' | 'fit';
  labels?: boolean;
}) {
  const title = titleOf(primary, record);
  return (
    <article
      aria-label={title}
      className="flex flex-col overflow-hidden rounded-md border border-border bg-surface shadow-1"
      style={{ padding: CARD.padding }}
    >
      <Cover
        ctx={ctx}
        record={record}
        field={cover}
        height={coverHeight}
        {...(fit ? { fit } : {})}
      />
      <p className="truncate font-[550]" style={{ height: CARD.title }}>
        {title}
      </p>
      {fields.map((f) => (
        <div key={f.id} className="min-w-0">
          {labels ? (
            <p className="truncate text-small text-text-2">{f.name}</p>
          ) : (
            <span className="sr-only">{f.name}: </span>
          )}
          <div className="flex min-w-0 items-center overflow-hidden" style={{ height: CARD.row }}>
            <SharedCell
              token={ctx.token}
              viewId={ctx.viewId}
              field={f}
              value={record.fields[f.id] ?? null}
            />
          </div>
        </div>
      ))}
    </article>
  );
}

const byIds = (fields: FieldMeta[], ids: readonly string[] | undefined) =>
  (ids ?? []).flatMap((id) => fields.find((f) => f.id === id) ?? []);

// ---- kanban ------------------------------------------------------------------------------

interface PublicStack {
  key: string;
  label: string;
  choice?: Choice;
  records: SharedRecord[];
}

/**
 * The stacks of a shared board: the empty stack first, then every choice in order, or (people
 * arrive as names) every name the cards carry, alphabetically. Without a stack field, one stack.
 */
function publicStacks(field: FieldMeta | undefined, records: SharedRecord[]): PublicStack[] {
  if (!field) return [{ key: 'all', label: 'All records', records }];
  const empty: PublicStack = {
    key: '',
    label: field.type === 'user' ? `No ${field.name.toLowerCase()}` : 'Uncategorized',
    records: [],
  };
  const stacks = new Map<string, PublicStack>([['', empty]]);
  if (field.type === 'singleSelect') {
    for (const choice of choicesOf(field)) {
      stacks.set(choice.id, { key: choice.id, label: choice.name, choice, records: [] });
    }
  } else {
    const names = new Set(
      records.flatMap((r) => {
        const v = r.fields[field.id];
        return Array.isArray(v) && typeof v[0] === 'string' ? [v[0]] : [];
      })
    );
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      stacks.set(`u:${name}`, { key: `u:${name}`, label: name, records: [] });
    }
  }
  for (const r of records) {
    const v = r.fields[field.id];
    const key =
      field.type === 'singleSelect'
        ? typeof v === 'string' && stacks.has(v)
          ? v
          : ''
        : Array.isArray(v) && typeof v[0] === 'string'
          ? `u:${v[0]}`
          : '';
    (stacks.get(key) ?? empty).records.push(r);
  }
  return [...stacks.values()];
}

function SharedKanban({ ctx }: { ctx: LayoutContext }) {
  const layout = ctx.shared.kanban ?? {};
  const primary = ctx.fields.find((f) => f.isPrimary);
  const stackField = ctx.fields.find((f) => f.id === layout.stackFieldId);
  const cardFields = byIds(ctx.fields, layout.cardFields);
  const cover = ctx.fields.find((f) => f.id === layout.coverFieldId);
  const data = useLayoutRecords(ctx, null);
  if (data.isPending) return <Loading />;
  if (!data.data) return <Failed />;
  const stacks = publicStacks(stackField, data.data.records);
  return (
    <>
      <ScrollRegion label={ctx.shared.view.name} className="min-h-0 flex-1 overflow-auto bg-app">
        <div className="flex h-full gap-3 p-3">
          {stacks.map((stack) =>
            stack.records.length === 0 && layout.collapseEmpty ? (
              <section
                key={stack.key}
                aria-label={`${stack.label}, no records`}
                className="flex w-10 shrink-0 flex-col items-center gap-2 rounded-md bg-sidebar py-3"
              >
                <span className="tnum text-small text-text-2">0</span>
                <span className="[writing-mode:vertical-rl] text-text-2">{stack.label}</span>
              </section>
            ) : (
              <section
                key={stack.key}
                aria-label={stack.label}
                className="flex w-[272px] shrink-0 flex-col rounded-md bg-sidebar"
              >
                <header className="flex h-10 shrink-0 items-center gap-2 px-3">
                  {stack.choice ? (
                    <ChoiceChip choice={stack.choice} />
                  ) : (
                    <span className="truncate font-[550] text-text-2">{stack.label}</span>
                  )}
                  <span className="tnum text-small text-text-2" data-testid="stack-count">
                    {stack.records.length.toLocaleString()}
                  </span>
                </header>
                <ScrollRegion
                  group
                  label={`${stack.label} records`}
                  className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
                >
                  {stack.records.map((r) => (
                    <Card
                      key={r.id}
                      ctx={ctx}
                      record={r}
                      primary={primary}
                      fields={cardFields}
                      cover={cover}
                      coverHeight={CARD.cover}
                    />
                  ))}
                  {stack.records.length === 0 && (
                    <p className="px-2 py-6 text-center text-small text-text-2">No records</p>
                  )}
                </ScrollRegion>
              </section>
            )
          )}
        </div>
      </ScrollRegion>
      <CountBar total={data.data.total} shown={data.data.records.length} />
    </>
  );
}

// ---- gallery -----------------------------------------------------------------------------

function SharedGallery({ ctx }: { ctx: LayoutContext }) {
  const layout = ctx.shared.gallery ?? {};
  const primary = ctx.fields.find((f) => f.isPrimary);
  const cardFields = byIds(ctx.fields, layout.cardFields);
  const cover = ctx.fields.find((f) => f.id === layout.coverFieldId);
  const size = CARD_SIZES[layout.cardSize ?? 'medium'];
  const data = useLayoutRecords(ctx, null);
  if (data.isPending) return <Loading />;
  if (!data.data) return <Failed />;
  return (
    <>
      <ScrollRegion
        label={ctx.shared.view.name}
        className="min-h-0 flex-1 overflow-auto bg-app p-4"
      >
        {data.data.records.length === 0 ? (
          <p className="p-6 text-center text-text-2">No records in this view.</p>
        ) : (
          <div
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size.width}px, 1fr))` }}
          >
            {data.data.records.map((r) => (
              <Card
                key={r.id}
                ctx={ctx}
                record={r}
                primary={primary}
                fields={cardFields}
                cover={cover}
                coverHeight={size.cover}
                fit={layout.coverFit ?? 'crop'}
                labels
              />
            ))}
          </div>
        )}
      </ScrollRegion>
      <CountBar total={data.data.total} shown={data.data.records.length} />
    </>
  );
}

// ---- list --------------------------------------------------------------------------------

function SharedList({ ctx }: { ctx: LayoutContext }) {
  const layout = ctx.shared.list ?? {};
  const primary = ctx.fields.find((f) => f.isPrimary);
  const rowFields = byIds(ctx.fields, layout.rowFields);
  const parent = layout.parentFieldId ? linkStub(layout.parentFieldId) : undefined;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const data = useLayoutRecords(ctx, null);
  const byId = useMemo(
    () => new Map((data.data?.records ?? []).map((r) => [r.id, r])),
    [data.data]
  );
  const rows = useMemo(
    () => listRows((data.data?.records ?? []).map(asRecord), parent, collapsed),
    [data.data, parent, collapsed]
  );
  if (data.isPending) return <Loading />;
  if (!data.data) return <Failed />;
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto bg-surface">
        {rows.length === 0 ? (
          <p className="p-6 text-center text-text-2">No records in this view.</p>
        ) : (
          <ul aria-label={ctx.shared.view.name}>
            {rows.map((row) => {
              const record = byId.get(row.record.id);
              if (!record) return null;
              const title = titleOf(primary, record);
              const open = !collapsed.has(record.id);
              return (
                <li
                  key={record.id}
                  className="flex h-[34px] items-center gap-3 border-b border-border pr-4"
                  style={{ paddingLeft: 12 + (row.level - 1) * 20 }}
                >
                  {row.childCount > 0 ? (
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
                      onClick={() => toggle(record.id)}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-text-2 hover:bg-hover"
                    >
                      {open ? (
                        <ChevronDown className="size-3.5" aria-hidden />
                      ) : (
                        <ChevronRight className="size-3.5" aria-hidden />
                      )}
                    </button>
                  ) : (
                    <span aria-hidden className="size-5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-[550]">{title}</span>
                  {rowFields.map((f) => (
                    <span key={f.id} className="flex max-w-56 min-w-0 items-center">
                      <span className="sr-only">{f.name}: </span>
                      <SharedCell
                        token={ctx.token}
                        viewId={ctx.viewId}
                        field={f}
                        value={record.fields[f.id] ?? null}
                      />
                    </span>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <CountBar total={data.data.total} shown={data.data.records.length} />
    </>
  );
}

// ---- calendar ----------------------------------------------------------------------------

/** Prev / Today / Next and the window's title. */
function WindowBar({
  title,
  onStep,
  onToday,
  children,
}: {
  title: string;
  onStep: (step: 1 | -1) => void;
  onToday: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <Button variant="outline" size="sm" onClick={onToday}>
        Today
      </Button>
      <Button variant="ghost" size="icon" aria-label="Previous" onClick={() => onStep(-1)}>
        <ChevronLeft className="size-4" aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Next" onClick={() => onStep(1)}>
        <ChevronRight className="size-4" aria-hidden />
      </Button>
      <h2 className="text-body font-semibold" aria-live="polite">
        {title}
      </h2>
      {children}
    </div>
  );
}

const DAY_HEADER = 28;
const LANE = 24;

function SharedCalendar({ ctx }: { ctx: LayoutContext }) {
  const layout = ctx.shared.calendar ?? {};
  const mode: CalendarMode = layout.mode ?? 'month';
  const primary = ctx.fields.find((f) => f.isPrimary);
  const pairs = useMemo(() => datePairsOf(ctx.fields, layout), [ctx.fields, layout]);
  const colorField = ctx.fields.find(
    (f) => f.id === layout.colorFieldId && f.type === 'singleSelect'
  );
  const today = localToday();
  const [anchor, setAnchor] = useState(today);
  const weeks = useMemo(() => visibleWeeks(mode, anchor), [mode, anchor]);
  const from = weeks[0]?.[0] ?? anchor;
  const to = weeks.at(-1)?.at(-1) ?? anchor;
  const data = useLayoutRecords(ctx, pairs.length > 0 ? { from, to } : null);
  const records = data.data?.records;
  const byId = useMemo(() => new Map((records ?? []).map((r) => [r.id, r])), [records]);
  const events = useMemo(
    () => eventsOf((records ?? []).map(asRecord), pairs, colorField),
    [records, pairs, colorField]
  );
  if (pairs.length === 0) {
    return <p className="p-6 text-center text-text-2">This calendar has no date field yet.</p>;
  }
  const month = anchor.slice(0, 7);
  const title = (id: string) => {
    const r = byId.get(id);
    return r ? titleOf(primary, r) : 'Unnamed record';
  };
  return (
    <>
      <WindowBar
        title={rangeTitle(mode, anchor)}
        onStep={(step) => setAnchor((a) => stepAnchor(mode, a, step))}
        onToday={() => setAnchor(today)}
      >
        <Legend pairs={pairs} colorField={colorField} />
      </WindowBar>
      {data.isError ? (
        <Failed />
      ) : (
        <ScrollRegion
          label={ctx.shared.view.name}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-app"
        >
          <div
            className="sticky top-0 z-10 grid border-b border-border bg-app"
            style={{ gridTemplateColumns: `repeat(${weeks[0]?.length ?? 7}, minmax(0, 1fr))` }}
          >
            {(weeks[0] ?? []).map((day) => (
              <div key={day} className="px-2 py-1 text-small font-medium text-text-2">
                {mode === 'day'
                  ? dayLabel(day)
                  : WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]}
              </div>
            ))}
          </div>
          {weeks.map((days) => {
            const segments = layoutRow(events, days);
            const lanes = segments.reduce((n, s) => Math.max(n, s.lane + 1), 0);
            return (
              <div
                key={days[0]}
                className="relative grid border-b border-border"
                style={{
                  gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
                  minHeight: DAY_HEADER + Math.max(lanes, 3) * LANE + 8,
                }}
              >
                {days.map((day) => {
                  const outside = mode === 'month' && day.slice(0, 7) !== month;
                  return (
                    <div
                      key={day}
                      data-day={day}
                      className={cn(
                        'border-r border-border last:border-r-0',
                        outside && 'bg-hover/40'
                      )}
                    >
                      <div className="flex h-7 items-center px-1.5">
                        <span
                          className={cn(
                            'tnum inline-flex size-6 items-center justify-center rounded-full text-small text-text-2',
                            day === today && 'bg-primary font-semibold text-primary-foreground'
                          )}
                        >
                          {Number(day.slice(8, 10))}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {segments.map((s) => {
                  const name = title(s.event.record.id);
                  const when =
                    s.event.end !== s.event.start
                      ? `${dayLabel(s.event.start)} to ${dayLabel(s.event.end)}`
                      : dayLabel(s.event.start);
                  return (
                    <div
                      key={s.event.key}
                      data-event-start={s.event.start}
                      title={`${name}, ${when}`}
                      className={cn(
                        'absolute flex h-[22px] items-center gap-1 overflow-hidden rounded-sm px-1.5 text-small shadow-1',
                        s.continuesBefore && 'rounded-l-none',
                        s.continuesAfter && 'rounded-r-none'
                      )}
                      style={{
                        ...chipStyle(s.event.color),
                        top: DAY_HEADER + s.lane * LANE,
                        left: `calc(${(s.col / days.length) * 100}% + 4px)`,
                        width: `calc(${(s.span / days.length) * 100}% - 8px)`,
                      }}
                    >
                      {s.event.time && (
                        <span className="tnum shrink-0 opacity-80">{s.event.time}</span>
                      )}
                      <span className="truncate">{name}</span>
                      <span className="sr-only">, {when}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </ScrollRegion>
      )}
      <CountBar total={data.data?.total ?? 0} shown={records?.length ?? 0} />
    </>
  );
}

/** The calendar's and timeline's legend: the colour field's choices, or each date pair's. */
function Legend({ pairs, colorField }: { pairs: DatePair[]; colorField: FieldMeta | undefined }) {
  const items = colorField
    ? choicesOf(colorField).map((c) => ({ key: c.id, label: c.name, color: c.color }))
    : pairs.length > 1
      ? pairs.map((p) => ({ key: p.start.id, label: p.start.name, color: p.color }))
      : [];
  if (items.length === 0) return null;
  return (
    <ul
      aria-label={colorField ? `Colours: ${colorField.name}` : 'Date fields'}
      className="ml-auto flex min-w-0 items-center gap-3 overflow-x-auto text-small text-text-2"
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

// ---- timeline ----------------------------------------------------------------------------

const LABEL_WIDTH = 200;
const ROW = 34;
const HEADER = 32;

function SharedTimeline({ ctx }: { ctx: LayoutContext }) {
  const layout = ctx.shared.timeline ?? {};
  const scale: TimelineScale = layout.scale ?? 'week';
  const { px, days, step } = SCALES[scale];
  const primary = ctx.fields.find((f) => f.isPrimary);
  const pair = useMemo(
    () => timelinePair(ctx.fields, layout, isCalendarDateField),
    [ctx.fields, layout]
  );
  const colorField = ctx.fields.find((f) => f.id === layout.colorFieldId);
  const groupField = ctx.fields.find((f) => f.id === layout.groupFieldId);
  const dependency = layout.dependencyFieldId ? linkStub(layout.dependencyFieldId) : undefined;
  const today = localToday();
  const [anchor, setAnchor] = useState(today);
  const window = windowOf(scale, anchor);
  const data = useLayoutRecords(ctx, pair ? window : null);
  const records = data.data?.records;
  const byId = useMemo(() => new Map((records ?? []).map((r) => [r.id, r])), [records]);
  const rows = useMemo(
    () => (pair ? timelineRowsOf((records ?? []).map(asRecord), pair, colorField, groupField) : []),
    [records, pair, colorField, groupField]
  );
  if (!pair) {
    return <p className="p-6 text-center text-text-2">This timeline has no date field yet.</p>;
  }
  const ticks = ticksOf(scale, window.from, days);
  const width = days * px;
  const bars = rows.flatMap((row, index) => (row.kind === 'bar' ? [{ row, index }] : []));
  const yOf = new Map(bars.map((b) => [b.row.event.record.id, b.index * ROW + ROW / 2]));
  const boxOf = new Map(
    bars.map((b) => [b.row.event.record.id, barBox(b.row.event, window.from, days, px)])
  );
  const arrows = dependenciesOf(
    bars.map((b) => b.row.event),
    dependency
  ).flatMap((d) => {
    const a = boxOf.get(d.from);
    const b = boxOf.get(d.to);
    const y1 = yOf.get(d.from);
    const y2 = yOf.get(d.to);
    if (!a || !b || y1 === undefined || y2 === undefined) return [];
    const path = dependencyPath(a.left + a.width, y1, b.left, y2, 0, width);
    return path ? [{ ...d, ...path }] : [];
  });
  const title = (id: string) => {
    const r = byId.get(id);
    return r ? titleOf(primary, r) : 'Unnamed record';
  };
  return (
    <>
      <WindowBar
        title={`${dayLabel(window.from)} – ${dayLabel(window.to)}`}
        onStep={(s) => setAnchor((a) => addDays(a, s * step))}
        onToday={() => setAnchor(today)}
      />
      {data.isError ? (
        <Failed />
      ) : (
        <ScrollRegion
          label={ctx.shared.view.name}
          className="min-h-0 flex-1 overflow-auto bg-surface"
        >
          <div className="relative" style={{ width: LABEL_WIDTH + width }}>
            <div
              className="sticky top-0 z-20 flex border-b border-border bg-header"
              style={{ height: HEADER }}
            >
              <div
                className="sticky left-0 z-10 shrink-0 border-r border-border bg-header px-3 py-2 text-small font-semibold text-text-2"
                style={{ width: LABEL_WIDTH }}
              >
                {primary?.name ?? 'Record'}
              </div>
              <div className="relative" style={{ width }}>
                {ticks.bottom.map((t) => (
                  <span
                    key={t.day}
                    className="absolute top-2 text-small whitespace-nowrap text-text-2"
                    style={{ left: t.offset * px + 4 }}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
            <ul aria-label={ctx.shared.view.name} className="relative">
              {rows.map((row) => {
                if (row.kind === 'group') {
                  return (
                    <li
                      key={`g:${row.key}`}
                      className="flex items-center gap-2 border-b border-border bg-header px-3"
                      style={{ height: ROW }}
                    >
                      <span className="sticky left-3 flex items-center gap-2 font-[550]">
                        {row.label}
                        <span className="tnum text-small text-text-2">{row.count}</span>
                      </span>
                    </li>
                  );
                }
                const e = row.event;
                const box = boxOf.get(e.record.id);
                const name = title(e.record.id);
                const when =
                  e.end !== e.start
                    ? `${dayLabel(e.start)} to ${dayLabel(e.end)}`
                    : dayLabel(e.start);
                return (
                  <li key={e.key} className="flex border-b border-border" style={{ height: ROW }}>
                    <span
                      className="sticky left-0 z-10 flex shrink-0 items-center truncate border-r border-border bg-surface px-3"
                      style={{ width: LABEL_WIDTH }}
                    >
                      <span className="truncate">{name}</span>
                      <span className="sr-only">, {when}</span>
                    </span>
                    <span className="relative" style={{ width }}>
                      {box && (
                        <span
                          aria-hidden
                          data-bar={e.record.id}
                          className="absolute top-[6px] flex h-[22px] items-center overflow-hidden rounded-sm px-1.5 text-small whitespace-nowrap shadow-1"
                          style={{ ...chipStyle(e.color), left: box.left, width: box.width }}
                        >
                          <span className="truncate">{name}</span>
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            {arrows.length > 0 && (
              <svg
                aria-hidden
                className="pointer-events-none absolute"
                style={{ left: LABEL_WIDTH, top: HEADER }}
                width={width}
                height={rows.length * ROW}
              >
                <defs>
                  <marker
                    id="shared-arrow"
                    viewBox="0 0 6 6"
                    refX="6"
                    refY="3"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6 z" className="fill-text-3" />
                  </marker>
                </defs>
                {arrows.map((a) => (
                  <path
                    key={`${a.from}>${a.to}`}
                    data-dependency={`${a.from}>${a.to}`}
                    d={a.d}
                    fill="none"
                    strokeWidth={1.5}
                    className={a.conflict ? 'stroke-danger' : 'stroke-text-3'}
                    {...(a.arrow ? { markerEnd: 'url(#shared-arrow)' } : {})}
                  />
                ))}
              </svg>
            )}
            {rows.length === 0 && data.isSuccess && (
              <p className="sticky left-0 p-6 text-center text-text-2">
                No records in this window.
              </p>
            )}
          </div>
        </ScrollRegion>
      )}
      <CountBar total={data.data?.total ?? 0} shown={records?.length ?? 0} />
    </>
  );
}
