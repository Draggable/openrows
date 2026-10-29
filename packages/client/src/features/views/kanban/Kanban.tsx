import {
  type FieldMeta,
  type KanbanLayout,
  type RecordData,
  type SavedViewQuery,
  type SelectOptions,
  type TableMeta,
  type UserRole,
  type ViewMeta,
  type ViewQuery,
  withNewChoices,
} from '@openrows/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Plus } from 'lucide-react';
import {
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiError, api } from '../../../api/client';
import { queryKeys } from '../../../api/keys';
import { recordQueries, useUpdateField, useUpdateView } from '../../../api/queries';
import { Button, toast } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { thumbnailUrl } from '../../attachments/upload';
import { useDirectory } from '../../collaborators/context';
import { Avatar } from '../../collaborators/UserChip';
import { buttonTarget, CellContent, ChoiceChip } from '../../grid/cells/CellContent';
import { cellText } from '../../grid/cells/model';
import { useWindowedRecords } from '../../grid/useWindowedRecords';
import { useEditRights } from '../../permissions/model';
import { type ExpandLayout, storedLayout, storeLayout } from '../../record/model';
import { RecordExpand, useDeleteRecordWithUndo } from '../../record/RecordExpand';
import { canConfigureView } from '../access';
import { useDebounced, useViewQuery } from '../toolbar/useViewQuery';
import { KanbanToolbar } from './KanbanToolbar';
import {
  afterIdFor,
  CARD,
  cardFieldsOf,
  cardHeight,
  coverOf,
  dropIndex,
  keyboardMove,
  type Stack,
  stackableFields,
  stackCounts,
  stackRows,
  stacksOf,
} from './model';

const STACK_WIDTH = 272;
const COLLAPSED_WIDTH = 44;
const STACK_GAP = 12;
const QUERY_DELAY = 250;

/** A card on its way somewhere: dragged now, or dropped and saving. */
type Moving = { record: RecordData; from: string | null; fromIndex: number };
type Target = { key: string | null; insertAt: number };

const keyOf = (key: string | null) => key ?? '\u0000empty';

/**
 * The kanban view (mockup c-kanban): the table's records as cards in stacks, one per
 * choice of a single select or per person of a user field (plus the empty stack first). Each
 * stack is its own virtualized, windowed view query (`within` the stack), so boards with
 * thousands of cards render only what's on screen. Dragging a card into another stack is a
 * normal record update (RecordService); where it lands within a stack is the view's manual order
 * (`POST /api/views/:viewId/order`), unless the view sorts. Alt+arrow keys move the focused
 * card without a mouse.
 */
export function Kanban({
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
  const canEditRecords = role === 'owner' || role === 'creator' || role === 'editor';
  const canEditSchema = role === 'owner' || role === 'creator';
  const canConfigure = canConfigureView(role, view);
  const directory = useDirectory();

  // The layout: saved for editors and up, kept for the page for lower roles.
  const updateView = useUpdateView(table.id);
  const [localLayout, setLocalLayout] = useState<KanbanLayout>({});
  const layout: KanbanLayout = { ...view?.config.kanban, ...localLayout };
  const saveLayout = (patch: KanbanLayout) => {
    setLocalLayout((l) => ({ ...l, ...patch }));
    if (!canConfigure || !view) return;
    updateView.mutate(
      { viewId: view.id, kanban: patch },
      { onError: () => toast.error("Couldn't save the board's settings") }
    );
  };

  const stackField = table.fields.find(
    (f) => f.id === layout.stackFieldId && stackableFields([f]).length === 1
  );
  const cardFields = cardFieldsOf(table.fields, layout);
  const coverField = table.fields.find(
    (f) => f.id === layout.coverFieldId && f.type === 'attachment' && !f.deletedAt
  );
  const primary = table.fields.find((f) => f.isPrimary);
  // Moving a card writes its stack field: under the field's edit permission.
  const rights = useEditRights(table, role);
  const canMove = canEditRecords && (!stackField || rights.canEditField(stackField));

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
  const sorted = (applied.sorts?.length ?? viewQuery.query.sorts.length) > 0;
  const canReorder = canConfigure && !sorted;

  // Card counts per stack: one grouped query for the whole board.
  const counts = useQuery({
    ...recordQueries.query(table.id, {
      viewId,
      query: {
        ...applied,
        sorts: [],
        groupBy: stackField ? [{ fieldId: stackField.id, direction: 'asc' }] : [],
      },
      limit: 0,
      count: true,
      groups: stackField !== undefined,
    }),
    enabled: stackField !== undefined,
  });
  const groups = counts.data?.groups ?? [];
  const stacks = useMemo(
    () => (stackField ? stacksOf(stackField, directory.list, groups) : []),
    [stackField, directory.list, groups]
  );
  const countBy = stackField ? stackCounts(stackField, groups) : new Map<string | null, number>();
  const total = counts.data?.total ?? 0;

  // Drag and drop, and moves in flight.
  const [dragging, setDragging] = useState<Moving | null>(null);
  const draggingRef = useRef<Moving | null>(null);
  const [over, setOver] = useState<Target | null>(null);
  const [saving, setSaving] = useState<(Moving & Target) | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const idLookups = useRef(new Map<string, (i: number) => string | undefined>());
  const scrollers = useRef(new Map<string, (i: number) => void>());

  const move = async (moving: Moving, to: Stack, insertAt: number) => {
    if (!stackField || !canMove) return;
    const sameStack = moving.from === to.key;
    if (
      sameStack &&
      (!canReorder || insertAt === moving.fromIndex || insertAt === moving.fromIndex + 1)
    )
      return;
    const idAt = idLookups.current.get(keyOf(to.key)) ?? (() => undefined);
    const afterId = afterIdFor(idAt, insertAt, moving.record.id);
    setSaving({ ...moving, key: to.key, insertAt });
    const title = primary ? cellText(primary, moving.record.fields[primary.id]) : '';
    try {
      if (!sameStack) {
        await api.records.update({
          params: { tableId: table.id, recordId: moving.record.id },
          body: { fields: { [stackField.id]: to.value } },
        });
      }
      if (canReorder) {
        await api.views.moveRecord({
          params: { viewId },
          body: { recordId: moving.record.id, afterId },
        });
      }
      setAnnouncement(`Moved ${title || 'the card'} to ${to.label}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't move the card");
    } finally {
      await qc.invalidateQueries({ queryKey: queryKeys.records.table(table.id) });
      setSaving(null);
    }
  };

  // Keyboard focus: one card at a time is in the tab order (roving tabindex).
  const [active, setActive] = useState<{ stack: number; index: number } | null>(null);
  const pendingFocus = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const focusCard = useCallback((at: { stack: number; index: number }) => {
    setActive(at);
    pendingFocus.current = true;
  }, []);
  useEffect(() => {
    if (!active || !pendingFocus.current) return;
    const el = boardRef.current?.querySelector<HTMLElement>(
      `[data-stack-index="${active.stack}"] [data-card-index="${active.index}"]`
    );
    if (el) {
      pendingFocus.current = false;
      el.focus();
    }
  });

  const boardV = useVirtualizer({
    horizontal: true,
    count: stacks.length + (canEditSchema && stackField?.type === 'singleSelect' ? 1 : 0),
    getScrollElement: () => boardRef.current,
    estimateSize: (i) => {
      const s = stacks[i];
      const collapsed = s && layout.collapseEmpty && (countBy.get(s.key) ?? 0) === 0;
      return (collapsed ? COLLAPSED_WIDTH : STACK_WIDTH) + STACK_GAP;
    },
    overscan: 2,
    paddingStart: 16,
    paddingEnd: 16,
  });
  const widthsKey = stacks
    .map((s) => (layout.collapseEmpty && (countBy.get(s.key) ?? 0) === 0 ? 'c' : 'o'))
    .join('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when widths change
  useEffect(() => boardV.measure(), [widthsKey]);

  const onCardKey = (e: KeyboardEvent, stackIndex: number, index: number, record: RecordData) => {
    const stack = stacks[stackIndex];
    if (!stack) return;
    const count = countBy.get(stack.key) ?? 0;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onExpandRecord(record.id);
      return;
    }
    if (e.altKey) {
      const planned = keyboardMove(
        e.key,
        { stack: stackIndex, index },
        { stacks: stacks.length, count },
        canReorder
      );
      if (!planned) return;
      e.preventDefault();
      if (!canMove) return;
      const moving = { record, from: stack.key, fromIndex: index };
      if (planned.kind === 'reorder') {
        void move(moving, stack, planned.insertAt).then(() =>
          focusCard({ stack: stackIndex, index: planned.insertAt > index ? index + 1 : index - 1 })
        );
      } else {
        const to = stacks[planned.stack];
        if (!to) return;
        void move(moving, to, 0).then(() => {
          boardV.scrollToIndex(planned.stack, { align: 'auto' });
          scrollers.current.get(keyOf(to.key))?.(0);
          focusCard({ stack: planned.stack, index: 0 });
        });
      }
      return;
    }
    let next: { stack: number; index: number } | null = null;
    if (e.key === 'ArrowUp' && index > 0) next = { stack: stackIndex, index: index - 1 };
    else if (e.key === 'ArrowDown' && index < count - 1)
      next = { stack: stackIndex, index: index + 1 };
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const step = e.key === 'ArrowLeft' ? -1 : 1;
      for (let s = stackIndex + step; s >= 0 && s < stacks.length; s += step) {
        const c = countBy.get(stacks[s]?.key ?? null) ?? 0;
        if (c > 0) {
          next = { stack: s, index: Math.min(index, c - 1) };
          break;
        }
      }
    } else if (e.key === 'Home') next = { stack: stackIndex, index: 0 };
    else if (e.key === 'End' && count > 0) next = { stack: stackIndex, index: count - 1 };
    if (!next) return;
    e.preventDefault();
    boardV.scrollToIndex(next.stack, { align: 'auto' });
    const target = stacks[next.stack];
    if (target) scrollers.current.get(keyOf(target.key))?.(next.index);
    focusCard(next);
  };

  // Add a stack (a choice of the single select), for schema roles only.
  const updateField = useUpdateField(table.id);
  const addStack = (name: string) => {
    if (stackField?.type !== 'singleSelect') return;
    const options = withNewChoices(stackField.options as SelectOptions, [name]);
    updateField.mutate(
      { fieldId: stackField.id, options },
      {
        onError: (err) =>
          toast.error(err instanceof ApiError ? err.message : "Couldn't add the stack"),
      }
    );
  };

  // Add a card in a stack: a record with the stack's value, opened in the expand view.
  const addCard = async (stack: Stack) => {
    if (!stackField) return;
    try {
      const created = await api.records.create({
        params: { tableId: table.id },
        body: { fields: { [stackField.id]: stack.value } },
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <KanbanToolbar
        fields={table.fields.filter((f) => !f.deletedAt)}
        layout={layout}
        stackField={stackField}
        cardFields={cardFields}
        onLayoutChange={saveLayout}
        query={viewQuery.query}
        onQueryChange={(patch: SavedViewQuery) => viewQuery.change(patch)}
        search={search}
        onSearchChange={setSearch}
        count={
          counts.isPending && stackField
            ? ''
            : `${total.toLocaleString()} ${total === 1 ? 'record' : 'records'}`
        }
      />
      <p id={hintId} className="sr-only">
        Enter opens the record. Arrow keys move between cards.
        {canMove ? ' Alt with the arrow keys moves the card.' : ''}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {!stackField ? (
        <KanbanSetup
          fields={stackableFields(table.fields)}
          onPick={(id) => saveLayout({ stackFieldId: id })}
        />
      ) : (
        <section
          ref={boardRef}
          aria-label="Board"
          className="relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-app"
        >
          <div className="relative h-full" style={{ width: boardV.getTotalSize() }}>
            {boardV.getVirtualItems().map((vs) => {
              const stack = stacks[vs.index];
              const style = { transform: `translateX(${vs.start}px)` };
              if (!stack) {
                return (
                  <div key="add" className="absolute top-3 bottom-3" style={style}>
                    <AddStack onAdd={addStack} />
                  </div>
                );
              }
              const count = countBy.get(stack.key) ?? 0;
              return (
                <div
                  key={keyOf(stack.key)}
                  data-stack-index={vs.index}
                  className="absolute top-3 bottom-3"
                  style={style}
                >
                  <StackColumn
                    table={table}
                    viewId={viewId}
                    query={applied}
                    stack={stack}
                    count={count}
                    collapsed={layout.collapseEmpty === true && count === 0}
                    primary={primary}
                    cardFields={cardFields}
                    coverField={coverField}
                    canEdit={canMove}
                    hintId={hintId}
                    active={active?.stack === vs.index ? active.index : null}
                    dragging={dragging}
                    over={over?.key === stack.key ? over.insertAt : null}
                    saving={saving}
                    onDragStart={(m) => {
                      draggingRef.current = m;
                      setDragging(m);
                    }}
                    onDragEnd={() => {
                      draggingRef.current = null;
                      setDragging(null);
                      setOver(null);
                    }}
                    onOver={(insertAt) =>
                      setOver((o) =>
                        o?.key === stack.key && o.insertAt === insertAt
                          ? o
                          : insertAt === null
                            ? o?.key === stack.key
                              ? null
                              : o
                            : { key: stack.key, insertAt }
                      )
                    }
                    onDrop={(insertAt) => {
                      const m = draggingRef.current;
                      draggingRef.current = null;
                      setDragging(null);
                      setOver(null);
                      if (m) void move(m, stack, insertAt);
                    }}
                    onCardKey={(e, index, record) => onCardKey(e, vs.index, index, record)}
                    onFocusCard={(index) => setActive({ stack: vs.index, index })}
                    onOpen={(record) => onExpandRecord(record.id)}
                    onAdd={() => void addCard(stack)}
                    idLookups={idLookups}
                    scrollers={scrollers}
                  />
                </div>
              );
            })}
          </div>
        </section>
      )}
      {expandedRecordId && (
        <RecordExpand
          key={expandedRecordId}
          table={table}
          fields={table.fields.filter((f) => !f.deletedAt)}
          hidden={[]}
          recordId={expandedRecordId}
          cached={undefined}
          index={null}
          total={0}
          userRole={role}
          canEdit={canEditRecords}
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

/** One stack: its header, its virtualized cards and the "New record" footer. */
function StackColumn({
  table,
  viewId,
  query,
  stack,
  count,
  collapsed,
  primary,
  cardFields,
  coverField,
  canEdit,
  hintId,
  active,
  dragging,
  over,
  saving,
  onDragStart,
  onDragEnd,
  onOver,
  onDrop,
  onCardKey,
  onFocusCard,
  onOpen,
  onAdd,
  idLookups,
  scrollers,
}: {
  table: TableMeta;
  viewId: string;
  query: Partial<ViewQuery>;
  stack: Stack;
  count: number;
  collapsed: boolean;
  primary: FieldMeta | undefined;
  cardFields: FieldMeta[];
  coverField: FieldMeta | undefined;
  canEdit: boolean;
  hintId: string;
  active: number | null;
  dragging: Moving | null;
  over: number | null;
  saving: (Moving & Target) | null;
  onDragStart: (m: Moving) => void;
  onDragEnd: () => void;
  onOver: (insertAt: number | null) => void;
  onDrop: (insertAt: number) => void;
  onCardKey: (e: KeyboardEvent, index: number, record: RecordData) => void;
  onFocusCard: (index: number) => void;
  onOpen: (record: RecordData) => void;
  onAdd: () => void;
  idLookups: RefObject<Map<string, (i: number) => string | undefined>>;
  scrollers: RefObject<Map<string, (i: number) => void>>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 30 });
  const stackQuery = useMemo(() => ({ ...query, within: [stack.within] }), [query, stack.within]);
  const data = useWindowedRecords(table.id, viewId, stackQuery, range.start, range.end, []);
  const slot = cardHeight(cardFields.length, coverField !== undefined) + CARD.gap;

  // The leaving card is hidden once dropped; the arriving one gets a slot.
  const savingHere = saving && saving.key === stack.key ? saving.insertAt : null;
  const leaving = saving ? data.indexOf(saving.record.id) : null;
  const insertAt = over ?? savingHere;
  const rows = stackRows(data.total, leaving, insertAt);

  const v = useVirtualizer({
    count: rows.count,
    getScrollElement: () => listRef.current,
    estimateSize: () => slot,
    overscan: 6,
    paddingStart: 4,
    paddingEnd: 4,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the card size changes
  useEffect(() => v.measure(), [slot]);
  const items = v.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;
  useEffect(() => {
    setRange((r) => (r.start === first && r.end === last ? r : { start: first, end: last }));
  }, [first, last]);

  const key = keyOf(stack.key);
  useEffect(() => {
    idLookups.current.set(key, (i) => data.getRow(i)?.id);
    scrollers.current.set(key, (i) => v.scrollToIndex(i, { align: 'auto' }));
  });
  useEffect(
    () => () => {
      idLookups.current.delete(key);
      scrollers.current.delete(key);
    },
    [key, idLookups, scrollers]
  );

  const insertAtOf = (e: DragEvent) => {
    const el = listRef.current;
    if (!el) return 0;
    const y = e.clientY - el.getBoundingClientRect().top + el.scrollTop - 4;
    return dropIndex(y, slot, data.total);
  };
  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      if (!dragging || !canEdit) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      onOver(insertAtOf(e));
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onOver(null);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      onDrop(insertAtOf(e));
    },
  };
  const label = `${stack.label}, ${count.toLocaleString()} ${count === 1 ? 'record' : 'records'}`;

  if (collapsed && over === null && savingHere === null) {
    return (
      <section
        aria-label={label}
        {...dropHandlers}
        className="flex h-full flex-col items-center gap-2 rounded-md bg-sidebar py-3"
        style={{ width: COLLAPSED_WIDTH }}
      >
        <span className="tnum text-small text-text-2">0</span>
        <span className="[writing-mode:vertical-rl] text-text-2">{stack.label}</span>
      </section>
    );
  }

  return (
    <section
      aria-label={label}
      {...dropHandlers}
      className="flex h-full flex-col rounded-md bg-sidebar"
      style={{ width: STACK_WIDTH }}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 px-3">
        <StackLabel stack={stack} />
        <span className="tnum text-small text-text-2" data-testid="stack-count">
          {count.toLocaleString()}
        </span>
      </header>
      <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto px-2">
        {/* biome-ignore lint/a11y/useSemanticElements: virtualized cards are positioned divs */}
        <div
          role="list"
          aria-label={stack.label}
          className="relative"
          style={{ height: v.getTotalSize() }}
        >
          {items.map((item) => {
            const row = rows.at(item.index);
            const style = { transform: `translateY(${item.start}px)`, height: slot - CARD.gap };
            if (row.slot) {
              const arriving = savingHere !== null && over === null ? saving?.record : undefined;
              return arriving ? (
                <div key="slot" className="absolute inset-x-0" style={style}>
                  <CardBody
                    record={arriving}
                    primary={primary}
                    cardFields={cardFields}
                    coverField={coverField}
                  />
                </div>
              ) : (
                <div
                  key="slot"
                  data-testid="drop-placeholder"
                  className="absolute inset-x-0 rounded-md border-2 border-dashed border-primary bg-primary/[0.06]"
                  style={style}
                />
              );
            }
            const record = data.getRow(row.index);
            if (!record) {
              return (
                <div
                  key={`i${row.index}`}
                  className="absolute inset-x-0 animate-pulse rounded-md bg-surface/60"
                  style={style}
                />
              );
            }
            const isDragged = dragging?.record.id === record.id;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a focusable card in a virtualized list
              <div
                key={record.id}
                role="listitem"
                aria-setsize={data.total}
                aria-posinset={row.index + 1}
                aria-describedby={hintId}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
                tabIndex={(active ?? 0) === row.index ? 0 : -1}
                data-card-index={row.index}
                data-record-id={record.id}
                draggable={canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', record.id);
                  onDragStart({ record, from: stack.key, fromIndex: row.index });
                }}
                onDragEnd={onDragEnd}
                onFocus={() => onFocusCard(row.index)}
                onKeyDown={(e) => onCardKey(e, row.index, record)}
                onClick={() => onOpen(record)}
                className={cn(
                  'absolute inset-x-0 cursor-pointer rounded-md outline-none focus-visible:shadow-[0_0_0_2px_var(--brand)]',
                  isDragged && 'opacity-40'
                )}
                style={style}
              >
                <CardBody
                  record={record}
                  primary={primary}
                  cardFields={cardFields}
                  coverField={coverField}
                />
              </div>
            );
          })}
        </div>
        {data.total === 0 && insertAt === null && (
          <p className="px-2 py-6 text-center text-small text-text-3">No records</p>
        )}
      </div>
      {canEdit && (
        <footer className="shrink-0 p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-text-2"
            onClick={onAdd}
            aria-label={`New record in ${stack.label}`}
          >
            <Plus className="size-4" aria-hidden />
            New record
          </Button>
        </footer>
      )}
    </section>
  );
}

function StackLabel({ stack }: { stack: Stack }) {
  if (stack.choice) return <ChoiceChip choice={stack.choice} />;
  if (stack.person) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Avatar person={stack.person} />
        <span className="truncate font-[550]">{stack.label}</span>
      </span>
    );
  }
  return <span className="truncate font-[550] text-text-2">{stack.label}</span>;
}

function CardBody({
  record,
  primary,
  cardFields,
  coverField,
}: {
  record: RecordData;
  primary: FieldMeta | undefined;
  cardFields: FieldMeta[];
  coverField: FieldMeta | undefined;
}) {
  const title = primary ? cellText(primary, record.fields[primary.id]) : '';
  const cover = coverField ? coverOf(record.fields[coverField.id]) : null;
  return (
    <article
      aria-label={title || 'Unnamed record'}
      className="flex h-full flex-col overflow-hidden rounded-md border border-border bg-surface shadow-1"
      style={{ padding: CARD.padding }}
    >
      {coverField && (
        <div
          className="mb-2 shrink-0 overflow-hidden rounded-sm bg-header"
          style={{ height: CARD.cover }}
        >
          {cover && coverField && (
            <img
              src={thumbnailUrl(coverField.tableId, cover.id)}
              alt={cover.filename}
              className="size-full object-cover"
              loading="lazy"
            />
          )}
        </div>
      )}
      <p className="truncate font-[550]" style={{ height: CARD.title }}>
        {title || <span className="text-text-3">Unnamed record</span>}
      </p>
      {cardFields.map((f) => (
        <div key={f.id} className="flex min-w-0 items-center" style={{ height: CARD.row }}>
          <span className="sr-only">{f.name}: </span>
          <span className="flex min-w-0 flex-1 overflow-hidden">
            <CellContent
              field={f}
              value={record.fields[f.id] ?? null}
              button={buttonTarget(f, record.id)}
            />
          </span>
        </div>
      ))}
    </article>
  );
}

/** "Add stack": a new choice of the stack field (owners and creators). */
function AddStack({ onAdd }: { onAdd: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  if (!editing) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-text-2"
        style={{ width: STACK_WIDTH }}
        onClick={() => setEditing(true)}
      >
        <Plus className="size-4" aria-hidden />
        Add stack
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-md bg-sidebar p-2"
      style={{ width: STACK_WIDTH }}
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim();
        if (n) onAdd(n);
        setName('');
        setEditing(false);
      }}
    >
      <input
        // biome-ignore lint/a11y/noAutofocus: opened on purpose by the user
        autoFocus
        aria-label="Stack name"
        value={name}
        maxLength={255}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
        className="h-8 rounded-sm border border-border bg-surface px-2 outline-none focus:border-brand"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Add
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A kanban view without a usable stack field: pick one. */
function KanbanSetup({
  fields,
  onPick,
}: {
  fields: FieldMeta[];
  onPick: (fieldId: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <h2 className="text-[15px] font-[550]">Stack records by a field</h2>
      {fields.length === 0 ? (
        <p className="max-w-sm text-text-2">
          Add a single select or a user field (one person) to this table to stack its records.
        </p>
      ) : (
        <div className="flex flex-wrap justify-center gap-2">
          {fields.map((f) => (
            <Button key={f.id} variant="secondary" size="sm" onClick={() => onPick(f.id)}>
              Stack by {f.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
