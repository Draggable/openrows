import type {
  ListLayout,
  RecordData,
  SavedViewQuery,
  TableMeta,
  UserRole,
  ViewMeta,
  ViewQuery,
} from '@openrows/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, ListTree, Plus } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../../../api/client';
import { queryKeys } from '../../../api/keys';
import { useUpdateView } from '../../../api/queries';
import { Button, Popover, PopoverContent, PopoverTrigger, toast } from '../../../components/ui';
import { MOBILE_QUERY, TOUCH_QUERY, useMediaQuery } from '../../../lib/media';
import { cn } from '../../../lib/utils';
import { buttonTarget, CellContent } from '../../grid/cells/CellContent';
import { cellText } from '../../grid/cells/model';
import { type ExpandLayout, storedLayout, storeLayout } from '../../record/model';
import { RecordExpand, useDeleteRecordWithUndo } from '../../record/RecordExpand';
import { canConfigureView } from '../access';
import { selfLinksOf } from '../timeline/model';
import { FieldPicker, FieldSelect, LayoutToolbar } from '../toolbar/LayoutToolbar';
import { useDebounced, useViewQuery } from '../toolbar/useViewQuery';
import { listRows, rowFieldsOf, treeKey } from './model';

const QUERY_DELAY = 250;
const PAGE = 1000;
/** Most records a list nests at once (the tree needs every parent loaded). */
export const LIST_LIMIT = 5000;
const ROW = 34;
const INDENT = 20;
const PHONE_INDENT = 14;
const TOUCH_ROW = 44;
const FIELD_WIDTH = 180;

/**
 * The list view: the view's records as a tree, nested by a link to records of the same
 * table (a record sits under the first record its parent field links to), indented per level,
 * with branches that collapse. The rows are virtualized; up to 5,000 records load (in pages of
 * 1,000) so every parent is there to nest under. Arrow keys follow the ARIA tree pattern.
 */
export function List({
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
  const [localLayout, setLocalLayout] = useState<ListLayout>({});
  const layout: ListLayout = { ...view?.config.list, ...localLayout };
  const saveLayout = (patch: ListLayout) => {
    setLocalLayout((l) => ({ ...l, ...patch }));
    if (!canConfigure || !view) return;
    updateView.mutate(
      { viewId: view.id, list: patch },
      { onError: () => toast.error("Couldn't save the list's settings") }
    );
  };
  const links = selfLinksOf(fields, table.id);
  const parentField = links.find((f) => f.id === layout.parentFieldId);
  const rowFields = rowFieldsOf(fields, layout);

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
  const loaded = useQuery({
    queryKey: [...queryKeys.records.queries(table.id), 'list-view', viewId, applied],
    queryFn: async () => {
      const records: RecordData[] = [];
      let total = 0;
      for (let offset = 0; offset < LIST_LIMIT; offset += PAGE) {
        const page = await api.records.query({
          params: { tableId: table.id },
          body: { viewId, query: applied, offset, limit: PAGE, count: offset === 0 },
        });
        if (offset === 0) total = page.total ?? page.records.length;
        records.push(...page.records);
        if (page.records.length < PAGE || records.length >= total) break;
      }
      return { records, total };
    },
    placeholderData: keepPreviousData,
  });
  const records = loaded.data?.records ?? [];
  const total = loaded.data?.total ?? 0;

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const rows = useMemo(
    () => listRows(records, parentField, collapsed),
    [records, parentField, collapsed]
  );
  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Phones: tap-sized rows, and the title gets the width (a tap opens the record sheet
  // with every field), with a narrower indent.
  const touch = useMediaQuery(TOUCH_QUERY);
  const phone = useMediaQuery(MOBILE_QUERY);
  const rowHeight = touch ? TOUCH_ROW : ROW;
  const indent = phone ? PHONE_INDENT : INDENT;
  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the row height changes
  useEffect(() => v.measure(), [rowHeight]);

  const [active, setActive] = useState(0);
  const pendingFocus = useRef(false);
  useEffect(() => {
    if (!pendingFocus.current) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${active}"]`);
    if (el) {
      pendingFocus.current = false;
      el.focus();
    }
  });
  const onRowKey = (e: KeyboardEvent, index: number, record: RecordData) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onExpandRecord(record.id);
      return;
    }
    const action = treeKey(e.key, rows, index, collapsed);
    if (!action) return;
    e.preventDefault();
    if ('toggle' in action) toggle(action.toggle);
    else {
      v.scrollToIndex(action.focus, { align: 'auto' });
      setActive(action.focus);
      pendingFocus.current = true;
    }
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
  const tabbable = Math.min(active, Math.max(0, rows.length - 1));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LayoutToolbar
        fields={fields}
        query={viewQuery.query}
        onQueryChange={(patch: SavedViewQuery) => viewQuery.change(patch)}
        search={search}
        onSearchChange={setSearch}
        count={
          loaded.isPending ? '' : `${total.toLocaleString()} ${total === 1 ? 'record' : 'records'}`
        }
      >
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm">
              <ListTree className="size-4 text-text-2" aria-hidden />
              {parentField ? `Nested by: ${parentField.name}` : 'Customize list'}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80" aria-label="Customize list">
            <FieldSelect
              label="Nest under"
              value={parentField?.id}
              fields={links}
              none="Don't nest"
              onChange={(id) => saveLayout({ parentFieldId: id })}
            />
            {links.length === 0 && (
              <p className="mb-2 text-small text-text-3">
                Add a link field to this table's own records (like "Parent") to nest them.
              </p>
            )}
            <FieldPicker
              label="Fields in rows"
              fields={fields}
              shown={rowFields}
              onChange={(ids) => saveLayout({ rowFields: ids })}
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
        Enter opens the record. Right and Left arrows expand and collapse.
      </p>
      {total > records.length && (
        <p className="border-b border-border px-3 py-1.5 text-small text-text-2" role="status">
          Showing the first {records.length.toLocaleString()} of {total.toLocaleString()} records.
          Filter the view to see the rest.
        </p>
      )}
      <section ref={scrollRef} aria-label="List" className="min-h-0 flex-1 overflow-y-auto">
        <div
          role="tree"
          aria-label={view?.name ?? 'Records'}
          className="relative"
          style={{ height: v.getTotalSize() }}
        >
          {v.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const { record } = row;
            const title = primary ? cellText(primary, record.fields[primary.id]) : '';
            const open = row.childCount > 0 && !collapsed.has(record.id);
            return (
              <div
                key={record.id}
                role="treeitem"
                aria-level={row.level}
                aria-posinset={row.posInSet}
                aria-setsize={row.setSize}
                aria-expanded={row.childCount > 0 ? open : undefined}
                aria-selected={tabbable === item.index}
                aria-describedby={hintId}
                aria-label={title || 'Unnamed record'}
                tabIndex={tabbable === item.index ? 0 : -1}
                data-row-index={item.index}
                data-record-id={record.id}
                onFocus={() => setActive(item.index)}
                onKeyDown={(e) => onRowKey(e, item.index, record)}
                onClick={() => onExpandRecord(record.id)}
                className="absolute inset-x-0 top-0 flex cursor-pointer items-center gap-2 border-b border-border px-3 outline-none hover:bg-hover focus-visible:shadow-[inset_0_0_0_2px_var(--brand)]"
                style={{ transform: `translateY(${item.start}px)`, height: rowHeight }}
              >
                <span
                  className="flex shrink-0 items-center"
                  style={{ paddingLeft: (row.level - 1) * indent }}
                  data-testid="indent"
                >
                  {row.childCount > 0 ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(record.id);
                      }}
                      className="grid size-5 place-items-center rounded-sm text-text-2 hover:bg-hover pointer-coarse:size-9"
                    >
                      <ChevronRight
                        className={cn('size-4 transition-transform', open && 'rotate-90')}
                        aria-hidden
                      />
                    </button>
                  ) : (
                    <span className="size-5 pointer-coarse:size-9" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate font-[550]">
                  {title || <span className="text-text-3">Unnamed record</span>}
                </span>
                {row.childCount > 0 && (
                  <span className="tnum shrink-0 text-small text-text-3">{row.childCount}</span>
                )}
                {(phone ? [] : rowFields).map((f) => (
                  <span
                    key={f.id}
                    className="flex shrink-0 items-center overflow-hidden"
                    style={{ width: FIELD_WIDTH }}
                  >
                    <span className="sr-only">{f.name}: </span>
                    <CellContent
                      field={f}
                      value={record.fields[f.id] ?? null}
                      button={buttonTarget(f, record.id)}
                    />
                  </span>
                ))}
              </div>
            );
          })}
        </div>
        {rows.length === 0 && !loaded.isPending && (
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
