import type {
  FieldMeta,
  GalleryCardSize,
  GalleryLayout,
  RecordData,
  SavedViewQuery,
  TableMeta,
  UserRole,
  ViewMeta,
  ViewQuery,
} from '@openrows/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { LayoutGrid, Plus } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api } from '../../../api/client';
import { queryKeys } from '../../../api/keys';
import { useUpdateView } from '../../../api/queries';
import { Button, Popover, PopoverContent, PopoverTrigger, toast } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { thumbnailUrl } from '../../attachments/upload';
import { buttonTarget, CellContent } from '../../grid/cells/CellContent';
import { cellText } from '../../grid/cells/model';
import { useWindowedRecords } from '../../grid/useWindowedRecords';
import { type ExpandLayout, storedLayout, storeLayout } from '../../record/model';
import { RecordExpand, useDeleteRecordWithUndo } from '../../record/RecordExpand';
import { canConfigureView } from '../access';
import { coverOf } from '../kanban/model';
import { FieldPicker, FieldSelect, LayoutToolbar } from '../toolbar/LayoutToolbar';
import { useDebounced, useViewQuery } from '../toolbar/useViewQuery';
import {
  CARD_SIZES,
  cardWidthFor,
  columnsFor,
  GALLERY,
  galleryCardHeight,
  galleryFieldsOf,
  nextCard,
} from './model';

const QUERY_DELAY = 250;

/**
 * The gallery view: the view's records as a grid of cards, each with the first image of
 * a cover attachment field, the primary field as its title and the card fields below. Rows of
 * cards are virtualized and the records load in windowed pages (the grid's), so a gallery of
 * thousands of cards renders only what's on screen. Arrow keys move between cards, Enter opens
 * one in the record expand view.
 */
export function Gallery({
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
  const fields = table.fields.filter((f) => !f.deletedAt);
  const primary = fields.find((f) => f.isPrimary);

  // The layout: saved for editors and up, kept for the page for lower roles.
  const updateView = useUpdateView(table.id);
  const [localLayout, setLocalLayout] = useState<GalleryLayout>({});
  const layout: GalleryLayout = { ...view?.config.gallery, ...localLayout };
  const saveLayout = (patch: GalleryLayout) => {
    setLocalLayout((l) => ({ ...l, ...patch }));
    if (!canConfigure || !view) return;
    updateView.mutate(
      { viewId: view.id, gallery: patch },
      { onError: () => toast.error("Couldn't save the gallery's settings") }
    );
  };
  const size: GalleryCardSize = layout.cardSize ?? 'medium';
  const cardFields = galleryFieldsOf(fields, layout);
  const coverField = fields.find((f) => f.id === layout.coverFieldId && f.type === 'attachment');
  const cardHeight = galleryCardHeight(size, cardFields.length, coverField !== undefined);

  const viewQuery = useViewQuery(table, view, canConfigure);
  const [search, setSearch] = useState('');
  const applied: Partial<ViewQuery> = useDebounced(
    {
      ...(view ? { filter: viewQuery.query.filter, sorts: viewQuery.query.sorts } : {}),
      groupBy: [],
      ...(search.trim() ? { search: search.trim() } : {}),
    },
    QUERY_DELAY
  );

  // Rows of cards: as many columns as fit the width.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1024);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  const columns = columnsFor(width, size);
  const [range, setRange] = useState({ start: 0, end: 60 });
  const data = useWindowedRecords(table.id, viewId, applied, range.start, range.end, []);
  const rowCount = Math.ceil(data.total / columns);
  const v = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => cardHeight + GALLERY.gap,
    overscan: 3,
    paddingStart: GALLERY.pad,
    paddingEnd: GALLERY.pad,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the card size changes
  useEffect(() => v.measure(), [cardHeight, columns]);
  const items = v.getVirtualItems();
  const first = (items[0]?.index ?? 0) * columns;
  const last = ((items.at(-1)?.index ?? 0) + 1) * columns - 1;
  useEffect(() => {
    setRange((r) => (r.start === first && r.end === last ? r : { start: first, end: last }));
  }, [first, last]);

  // Keyboard focus: one card at a time is in the tab order (roving tabindex).
  const [active, setActive] = useState(0);
  const pendingFocus = useRef(false);
  useEffect(() => {
    if (!pendingFocus.current) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-card-index="${active}"]`);
    if (el) {
      pendingFocus.current = false;
      el.focus();
    }
  });
  const onCardKey = (e: KeyboardEvent, index: number, record: RecordData) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onExpandRecord(record.id);
      return;
    }
    const next = nextCard(e.key, index, columns, data.total);
    if (next === null) return;
    e.preventDefault();
    v.scrollToIndex(Math.floor(next / columns), { align: 'auto' });
    setActive(next);
    pendingFocus.current = true;
  };

  const addRecord = async () => {
    try {
      const created = await api.records.create({ params: { tableId: table.id }, body: {} });
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
  const cardWidth = cardWidthFor(width, size);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LayoutToolbar
        fields={fields}
        query={viewQuery.query}
        onQueryChange={(patch: SavedViewQuery) => viewQuery.change(patch)}
        search={search}
        onSearchChange={setSearch}
        count={`${data.total.toLocaleString()} ${data.total === 1 ? 'record' : 'records'}`}
      >
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm">
              <LayoutGrid className="size-4 text-text-2" aria-hidden />
              Customize cards
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80" aria-label="Customize cards">
            <FieldSelect
              label="Cover image"
              value={coverField?.id}
              fields={fields.filter((f) => f.type === 'attachment')}
              onChange={(id) => saveLayout({ coverFieldId: id })}
            />
            {coverField && (
              <label className="mb-2 flex h-8 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={layout.coverFit === 'fit'}
                  onChange={(e) => saveLayout({ coverFit: e.target.checked ? 'fit' : 'crop' })}
                  className="size-4 accent-[var(--accent)]"
                />
                Fit the whole image
              </label>
            )}
            <fieldset className="mb-2">
              <legend className="mb-1 text-small text-text-2">Card size</legend>
              <div className="flex gap-1">
                {(['small', 'medium', 'large'] as const).map((s) => (
                  <Button
                    key={s}
                    variant={s === size ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={s === size}
                    onClick={() => saveLayout({ cardSize: s })}
                    className={cn(s === size && 'bg-selected')}
                  >
                    {s[0]?.toUpperCase()}
                    {s.slice(1)}
                  </Button>
                ))}
              </div>
            </fieldset>
            <FieldPicker
              label="Fields on cards"
              fields={fields}
              shown={cardFields}
              onChange={(ids) => saveLayout({ cardFields: ids })}
            />
          </PopoverContent>
        </Popover>
        {canEdit && (
          <Button variant="ghost" size="sm" onClick={() => void addRecord()}>
            <Plus className="size-4 text-text-2" aria-hidden />
            New record
          </Button>
        )}
      </LayoutToolbar>
      <p id={hintId} className="sr-only">
        Enter opens the record. Arrow keys move between cards.
      </p>
      <section
        ref={scrollRef}
        aria-label="Gallery"
        className="relative min-h-0 flex-1 overflow-y-auto bg-app"
      >
        {/* biome-ignore lint/a11y/useSemanticElements: virtualized cards are positioned divs */}
        <div
          role="list"
          aria-label="Cards"
          className="relative"
          style={{ height: v.getTotalSize() }}
        >
          {items.map((row) =>
            Array.from({ length: columns }, (_, col) => {
              const index = row.index * columns + col;
              if (index >= data.total) return null;
              const record = data.getRow(index);
              const style = {
                transform: `translate(${GALLERY.pad + col * (cardWidth + GALLERY.gap)}px, ${row.start}px)`,
                width: cardWidth,
                height: cardHeight,
              };
              if (!record) {
                return (
                  <div
                    key={`i${index}`}
                    className="absolute top-0 left-0 animate-pulse rounded-md bg-surface/60"
                    style={style}
                  />
                );
              }
              return (
                // biome-ignore lint/a11y/useSemanticElements: a focusable card in a virtualized list
                <div
                  key={record.id}
                  role="listitem"
                  aria-setsize={data.total}
                  aria-posinset={index + 1}
                  aria-describedby={hintId}
                  tabIndex={active === index ? 0 : -1}
                  data-card-index={index}
                  data-record-id={record.id}
                  onFocus={() => setActive(index)}
                  onKeyDown={(e) => onCardKey(e, index, record)}
                  onClick={() => onExpandRecord(record.id)}
                  className="absolute top-0 left-0 cursor-pointer rounded-md outline-none focus-visible:shadow-[0_0_0_2px_var(--brand)]"
                  style={style}
                >
                  <GalleryCard
                    record={record}
                    primary={primary}
                    cardFields={cardFields}
                    coverField={coverField}
                    coverHeight={CARD_SIZES[size].cover}
                    fit={layout.coverFit === 'fit'}
                  />
                </div>
              );
            })
          )}
        </div>
        {data.total === 0 && !data.isPending && (
          <p className="py-12 text-center text-text-3">No records</p>
        )}
      </section>
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

function GalleryCard({
  record,
  primary,
  cardFields,
  coverField,
  coverHeight,
  fit,
}: {
  record: RecordData;
  primary: FieldMeta | undefined;
  cardFields: FieldMeta[];
  coverField: FieldMeta | undefined;
  coverHeight: number;
  fit: boolean;
}) {
  const title = primary ? cellText(primary, record.fields[primary.id]) : '';
  const cover = coverField ? coverOf(record.fields[coverField.id]) : null;
  return (
    <article
      aria-label={title || 'Unnamed record'}
      className="flex h-full flex-col overflow-hidden rounded-md border border-border bg-surface shadow-1"
      style={{ padding: GALLERY.padding }}
    >
      {coverField && (
        <div
          className="mb-2 shrink-0 overflow-hidden rounded-sm bg-header"
          style={{ height: coverHeight }}
          data-testid="card-cover"
        >
          {cover && (
            <img
              src={thumbnailUrl(coverField.tableId, cover.id)}
              alt={cover.filename}
              className={cn('size-full', fit ? 'object-contain' : 'object-cover')}
              loading="lazy"
            />
          )}
        </div>
      )}
      <p className="truncate font-[550]" style={{ height: GALLERY.title }}>
        {title || <span className="text-text-3">Unnamed record</span>}
      </p>
      {cardFields.map((f) => (
        <div key={f.id} className="min-w-0">
          <p className="truncate text-small text-text-2" style={{ height: GALLERY.label }}>
            {f.name}
          </p>
          <div
            className="flex min-w-0 items-center overflow-hidden"
            style={{ height: GALLERY.row }}
          >
            <CellContent
              field={f}
              value={record.fields[f.id] ?? null}
              button={buttonTarget(f, record.id)}
            />
          </div>
        </div>
      ))}
    </article>
  );
}
