import type {
  AttachmentValue,
  FieldMeta,
  RecordData,
  TableMeta,
  UserRole,
  ViewMeta,
  ViewQuery,
} from '@openrows/shared';
import { downloads } from '@openrows/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDownToLine,
  CircleAlert,
  Copy,
  CopyPlus,
  Eraser,
  Maximize2,
  MessageSquare,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ApiError, downloadUrl } from '../../api/client';
import { commentQueries } from '../../api/queries';
import {
  bulkRecords,
  useCreateRecords,
  useUpdateRecord,
  type WriteOptions,
} from '../../api/records';
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from '../../components/ui';
import { MOBILE_QUERY, TOUCH_QUERY, useMediaQuery } from '../../lib/media';
import { cn } from '../../lib/utils';
import { dragHasFiles, uploadFiles } from '../attachments/upload';
import { useFieldManagement } from '../fields/useFieldManagement';
import { ImportDialog } from '../import/ImportDialog';
import { takeImport } from '../import/pending';
import { FieldPermissionsDialog } from '../permissions/FieldPermissionsDialog';
import { isLockedField, useEditRights } from '../permissions/model';
import {
  PeerCellMarker,
  useCellPresence,
  usePeerCellDescriptions,
  usePresence,
} from '../realtime/Presence';
import { cellKeyOf } from '../realtime/presence-model';
import { type ExpandLayout, storedLayout, storeLayout } from '../record/model';
import { RecordExpand, useDeleteRecordWithUndo } from '../record/RecordExpand';
import { canConfigureView } from '../views/access';
import { colorConditionsOf, rowColorOf } from '../views/rowColor/model';
import { useRowColor } from '../views/rowColor/useRowColor';
import { findMatches, type GroupHeader, groupHeaders } from '../views/toolbar/model';
import { useDebounced, useViewQuery } from '../views/toolbar/useViewQuery';
import { type FindState, ViewToolbar } from '../views/toolbar/ViewToolbar';
import { AddFieldButton } from './AddFieldButton';
import { type ColumnActions, ColumnHeader } from './ColumnHeader';
import {
  CellContent,
  CellEditor,
  cellText,
  coerceValue,
  type EditorMove,
  type EditorResult,
  editorKind,
  fieldDef,
  opensEditor,
  sameValue,
} from './cells';
import {
  copyPayload,
  type Fields,
  type PastedCell,
  planFill,
  planPaste,
  readClipboard,
} from './clipboard/clipboard';
import { type Step, updateStep } from './history/history';
import { useRecordHistory } from './history/useRecordHistory';
import {
  ADD_COLUMN_WIDTH,
  FOOTER_HEIGHT,
  type GridColumn,
  GUTTER_WIDTH,
  gridColumns,
  HEADER_HEIGHT,
  mergeOrder,
  moveField,
  orderedFields,
  phoneLayout,
  rowHeightOf,
  TOUCH_ROW_HEIGHT,
} from './layout';
import {
  type Cell,
  cellSelection,
  type GridSize,
  inRange,
  isSingleCell,
  navigate,
  type Selection,
  selectColumns,
  selectionRange,
  selectRows,
} from './selection';
import { useGridLayout } from './useGridLayout';
import { type AggregateRequest, useWindowedRecords } from './useWindowedRecords';

/** Height of one group header band above the first record of a group. */
const GROUP_HEADER_HEIGHT = 32;
/** How long the grid waits for typing in the toolbar to settle before it queries. */
const QUERY_DELAY = 250;

type Editing = { cell: Cell; initialText?: string };
type Rect = { top: number; bottom: number; left: number; right: number };

/** Ctrl on Windows and Linux, ⌘ on macOS (either works everywhere). */
const isMod = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

const cellKey = (c: Cell) => `${c.row}:${c.col}`;
/** Save errors are kept per record and field, so they follow the record through scrolling. */
const errorKey = (recordId: string, fieldId: string) => `${recordId}:${fieldId}`;

/** Aggregates the summary bar shows: sums under numbers, "checked" counts under checkboxes. */
function summaryFor(field: FieldMeta): AggregateRequest | null {
  const { def } = fieldDef(field);
  if (def.editor.kind === 'checkbox') return { fieldId: field.id, fn: 'filled' };
  if (def.sort === 'number' && !def.computed) return { fieldId: field.id, fn: 'sum' };
  return null;
}

/**
 * The grid view: DOM row and column virtualization (TanStack Virtual, ADR-007) over the
 * view query, loaded in windows of 100 records. Sticky header, row numbers, the primary field
 * and any frozen columns pinned left, a summary bar, keyboard navigation and range selection
 * (ARIA grid pattern with roving focus), a renderer and an editor per field type (
 * `cells/`), optimistic saves with an inline error on the cell when the server refuses one,
 * column resize/reorder/freeze and row height saved to the view. Space, Shift+Space or the
 * expand icon in the row gutter opens the record expand view (`?record=<id>` in the URL).
 * The view toolbar filters, sorts, groups (header bands above each group's first record)
 * and finds (Ctrl/Cmd+F), all on the server. Copy/paste, the fill handle, range clear,
 * duplicate/delete from the context menu and undo/redo (`clipboard/`, `history/`) write
 * through the RecordService's bulk calls.
 */
export function Grid({
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
  /** The record open in the expand view (the `record` search param). */
  expandedRecordId?: string | undefined;
  onExpandRecord?: (recordId: string | null) => void;
}) {
  const canEditRecords = role === 'owner' || role === 'creator' || role === 'editor';
  const canEditSchema = role === 'owner' || role === 'creator';
  // Table and field edit permissions: the server refuses the rest; this disables it.
  const rights = useEditRights(table, role);
  // Live comments per record, for the row header badges.
  const commentCounts = useQuery(commentQueries.counts(table.id)).data?.counts;
  const canEditCell = (field: FieldMeta) => canEditRecords && rights.canEditField(field);
  const canAddRecords = canEditRecords && rights.canAdd;
  const canDeleteRecords = canEditRecords && rights.canDelete;
  const [permissionsField, setPermissionsField] = useState<FieldMeta | null>(null);
  const canConfigure = canConfigureView(role, view);
  const { layout, preview, save } = useGridLayout(table.id, view, canConfigure);
  const hidden = (layout.hiddenFields ?? []).filter((id) =>
    table.fields.some((f) => f.id === id && !f.isPrimary)
  );
  const fullOrder = orderedFields(table.fields, layout).map((f) => f.id);
  // Touch screens: rows of at least 44 px, and on phones a narrow frozen primary column.
  const touch = useMediaQuery(TOUCH_QUERY);
  const phone = useMediaQuery(MOBILE_QUERY);
  const columns = gridColumns(
    table.fields.filter((f) => !hidden.includes(f.id)),
    phone ? phoneLayout(table.fields, layout) : layout
  );
  const fieldManagement = useFieldManagement({ table, fullOrder, hidden, saveLayout: save });
  const frozen = columns.filter((c) => c.frozen);
  const scrolling = columns.filter((c) => !c.frozen);
  const frozenWidth = GUTTER_WIDTH + frozen.reduce((w, c) => w + c.width, 0);
  const scrollWidth = scrolling.reduce((w, c) => w + c.width, 0);
  const totalWidth = frozenWidth + scrollWidth + ADD_COLUMN_WIDTH;
  const rowHeight = touch ? Math.max(TOUCH_ROW_HEIGHT, rowHeightOf(layout)) : rowHeightOf(layout);

  const [importing, setImporting] = useState(false);
  // A file picked on Home for this new table opens the import dialog once.
  const [importFile, setImportFile] = useState<File | undefined>();
  useEffect(() => {
    if (!canEditRecords) return;
    const file = takeImport(table.id);
    if (!file) return;
    setImportFile(file);
    setImporting(true);
  }, [table.id, canEditRecords]);

  // The toolbar's query and find in view.
  const viewQuery = useViewQuery(table, view, canConfigure);
  const [findTerm, setFindTerm] = useState('');
  const [findCursor, setFindCursor] = useState<number | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const search = findTerm.trim();
  // Until the view has loaded, the server applies its saved query (`viewId`) on its own.
  const applied: Partial<ViewQuery> = useDebounced(
    { ...(view ? viewQuery.query : {}), ...(search ? { search } : {}) },
    QUERY_DELAY
  );
  const groupBy = applied.groupBy ?? [];
  // Row colours: by a select field here, by conditions on the server.
  const rowColor = useRowColor(table.id, view, canConfigure);
  const colorConditions = useDebounced(colorConditionsOf(rowColor.rowColor), QUERY_DELAY);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 50 });
  const aggregates = columns.flatMap((c) => summaryFor(c.field) ?? []);
  const data = useWindowedRecords(
    table.id,
    viewId,
    applied,
    range.start,
    range.end,
    aggregates,
    colorConditions
  );
  const total = data.total;
  const headers = groupHeaders(groupBy.length > 0 ? (data.groups ?? []) : []);
  const headersKey = [...headers.entries()].map(([i, h]) => `${i}:${h.length}`).join(',');
  const bandOf = (index: number) => (headers.get(index)?.length ?? 0) * GROUP_HEADER_HEIGHT;

  const rowV = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowHeight + bandOf(i),
    overscan: 12,
    scrollMargin: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    scrollPaddingEnd: FOOTER_HEIGHT,
  });
  const colV = useVirtualizer({
    horizontal: true,
    count: scrolling.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => scrolling[i]?.width ?? 0,
    overscan: 3,
    scrollMargin: frozenWidth,
    scrollPaddingStart: frozenWidth,
  });
  const widthsKey = columns.map((c) => c.width).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when sizes change
  useLayoutEffect(() => {
    rowV.measure();
    colV.measure();
  }, [rowHeight, widthsKey, frozenWidth, headersKey]);

  const virtualRows = rowV.getVirtualItems();
  const virtualCols = colV.getVirtualItems();
  const first = virtualRows[0]?.index ?? 0;
  const last = virtualRows.at(-1)?.index ?? 0;
  useEffect(() => {
    setRange((r) => (r.start === first && r.end === last ? r : { start: first, end: last }));
  }, [first, last]);

  // Selection, focus and editing.
  const [sel, setSel] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const pendingFocus = useRef<Cell | null>(null);
  const viewportRows = Math.max(
    1,
    Math.floor(
      ((scrollRef.current?.clientHeight ?? 600) - HEADER_HEIGHT - FOOTER_HEIGHT) / rowHeight
    )
  );
  const size: GridSize = { rows: total, cols: columns.length, pageRows: viewportRows };
  // Presence: share the selected cell and an open editor; show everyone else's.
  const presence = usePresence();
  const peerCells = useCellPresence();
  const peerDescriptions = usePeerCellDescriptions(peerCells);
  const presenceRecord = sel ? data.getRow(sel.focus.row)?.id : undefined;
  const presenceField = sel ? columns[sel.focus.col]?.field.id : undefined;
  const { update: updatePresence } = presence;
  useEffect(() => {
    updatePresence({
      recordId: presenceRecord && presenceField ? presenceRecord : null,
      fieldId: presenceRecord && presenceField ? presenceField : null,
      editing: editing !== null && presenceRecord !== undefined,
    });
  }, [updatePresence, presenceRecord, presenceField, editing]);
  useEffect(
    () => () => updatePresence({ recordId: null, fieldId: null, editing: false }),
    [updatePresence]
  );
  const selRange = sel ? selectionRange(sel, size) : null;
  const active = sel?.focus ?? null;

  const scrollToCell = useCallback(
    (cell: Cell) => {
      rowV.scrollToIndex(cell.row, { align: 'auto' });
      const column = columns[cell.col];
      if (column && !column.frozen) colV.scrollToIndex(cell.col - frozen.length, { align: 'auto' });
      pendingFocus.current = cell;
    },
    [rowV, colV, columns, frozen.length]
  );

  // After a move, focus the cell once it is rendered.
  useEffect(() => {
    const cell = pendingFocus.current;
    if (!cell || editing) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${cellKey(cell)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const select = (next: Selection) => {
    setSel(next);
    scrollToCell(next.focus);
  };

  // Find in view: the server keeps the records matching the term; Enter/Shift+Enter (or the
  // arrows) step through them, selecting the first matching cell while focus stays in the box.
  const matchColumns = (record: RecordData | undefined) =>
    record
      ? findMatches(
          search,
          columns.map((c) => c.field),
          (f) => cellText(f, record.fields[f.id])
        )
      : [];
  const findStep = (by: 1 | -1) => {
    if (!search || total === 0) return;
    const row =
      findCursor === null ? (by === 1 ? 0 : total - 1) : (findCursor + by + total) % total;
    setFindCursor(row);
    const cell = { row, col: matchColumns(data.getRow(row))[0] ?? 0 };
    setSel(cellSelection(cell));
    rowV.scrollToIndex(row, { align: 'auto' });
    const column = columns[cell.col];
    if (column && !column.frozen) colV.scrollToIndex(cell.col - frozen.length, { align: 'auto' });
  };
  const find: FindState = {
    term: findTerm,
    setTerm: (term) => {
      setFindTerm(term);
      setFindCursor(null);
    },
    next: () => findStep(1),
    previous: () => findStep(-1),
    position: !search
      ? null
      : total === 0
        ? 'No matches'
        : findCursor === null
          ? `${total.toLocaleString()} found`
          : `${(findCursor + 1).toLocaleString()} of ${total.toLocaleString()}`,
    inputRef: findRef,
    close: () => {
      setFindTerm('');
      setFindCursor(null);
      const back = sel?.focus ?? { row: 0, col: 0 };
      if (total > 0) scrollToCell(back);
    },
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const update = useUpdateRecord(table.id);
  const create = useCreateRecords(table.id);
  const errorText = (err: unknown) =>
    err instanceof ApiError ? err.message : "Couldn't save the change";
  const onWriteError = (err: unknown) => toast.error(errorText(err));

  // Cells whose last save failed (the optimistic value rolled back), with the reason.
  const [cellErrors, setCellErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const setCellError = (key: string, message: string | null) =>
    setCellErrors((prev) => {
      if (message === null ? !prev.has(key) : prev.get(key) === message) return prev;
      const next = new Map(prev);
      if (message === null) next.delete(key);
      else next.set(key, message);
      return next;
    });

  const writeCell = (cell: Cell, value: unknown, opts: WriteOptions = {}) => {
    const record = data.getRow(cell.row);
    const column = columns[cell.col];
    if (record && column) writeValue(record, column.field.id, value, opts);
  };

  const writeValue = (
    record: RecordData,
    fieldId: string,
    value: unknown,
    opts: WriteOptions = {}
  ) => {
    const key = errorKey(record.id, fieldId);
    setCellError(key, null);
    const fields = { [fieldId]: value };
    const step = updateStep([{ id: record.id, fields }], () => record.fields);
    const typecast = opts.typecast ? { typecast: true } : {};
    void history.enqueue(() =>
      update.mutateAsync({ recordId: record.id, fields, ...typecast }).then(
        // Redo writes the stored value: the option ids a typecast made of the names.
        (saved) =>
          history.record({
            label: 'the edit',
            steps: [
              {
                ...step,
                records: step.records.map((r) => ({
                  ...r,
                  after: { [fieldId]: saved.fields[fieldId] ?? null },
                })),
              },
            ],
          }),
        (err: unknown) => {
          setCellError(key, errorText(err));
          onWriteError(err);
        }
      )
    );
  };

  // Files dropped on an attachment cell upload, then append to the cell as one edit.
  const [dropCell, setDropCell] = useState<string | null>(null);
  const dropFiles = async (cell: Cell, files: File[]) => {
    const record = data.getRow(cell.row);
    const column = columns[cell.col];
    if (!record || !column || files.length === 0) return;
    setSel(cellSelection(cell));
    const fieldId = column.field.id;
    const label = files.length === 1 ? `"${files[0]?.name}"` : `${files.length} files`;
    const progress = toast.loading(`Uploading ${label}…`);
    const { uploaded, error } = await uploadFiles(table.id, fieldId, files);
    toast.dismiss(progress);
    if (error) toast.error(error instanceof Error ? error.message : "Couldn't upload the file.");
    if (uploaded.length === 0) return;
    const before = record.fields[fieldId];
    const current = (Array.isArray(before) ? before : []) as AttachmentValue[];
    writeValue(record, fieldId, [...current, ...uploaded]);
  };

  const startEdit = (cell: Cell, typed?: string) => {
    const column = columns[cell.col];
    const record = data.getRow(cell.row);
    if (!canEditRecords || !column || !record) return;
    if (!canEditCell(column.field)) {
      if (column.field.synced) {
        toast(`${column.field.name} is synced from another table`);
      } else if (editorKind(column.field) !== 'none') {
        toast(`You don't have permission to edit ${column.field.name}`);
      }
      return;
    }
    const kind = editorKind(column.field);
    if (kind === 'checkbox') {
      writeCell(cell, record.fields[column.field.id] !== true);
      return;
    }
    if (kind === 'rating') {
      // Typing a digit rates (0 clears); the icons are clickable too.
      if (typed && /^\d$/.test(typed)) {
        const value = typed === '0' ? null : coerceValue(column.field, Number(typed));
        const changed = !sameValue(value, record.fields[column.field.id]);
        if ((value !== null || typed === '0') && changed) writeCell(cell, value);
      }
      return;
    }
    if (!opensEditor(kind)) return;
    setEditing({ cell, initialText: typed });
  };

  const commitEdit = (result: EditorResult | null, move: EditorMove) => {
    if (!editing) return;
    const { cell } = editing;
    const column = columns[cell.col];
    const record = data.getRow(cell.row);
    if (result && column && record) {
      if ('error' in result) {
        setCellError(errorKey(record.id, column.field.id), result.error);
        toast.error(result.error);
      } else if (!sameValue(result.value, record.fields[column.field.id])) {
        writeCell(cell, result.value, { typecast: result.typecast });
      }
    }
    setEditing(null);
    if (move === 'away') return;
    const target =
      move === 'stay'
        ? cell
        : (navigate(cellSelection(cell), { key: 'Tab', shiftKey: move === 'prev' }, size)?.focus ??
          cell);
    setSel(cellSelection(target));
    scrollToCell(target);
  };

  // Bulk edits: paste, fill, clear, duplicate and delete, each one undoable entry.
  const qc = useQueryClient();
  const history = useRecordHistory(table.id);
  const fieldsOf = columns.map((c) => c.field);
  const editableIds = new Set(table.fields.filter(canEditCell).map((f) => f.id));
  const settableIds = new Set(
    table.fields.filter((f) => canEditRecords && rights.canSetOnCreate(f)).map((f) => f.id)
  );

  /** Writes cells of many rows (and creates records), then records the undo entry. */
  const writeRows = (
    label: string,
    allWrites: { id: string; fields: Fields }[],
    current: (id: string) => Fields | undefined,
    allCreates: Fields[] = [],
    opts: WriteOptions = {}
  ) => {
    // Cells of fields the user can't edit are left out, and creates need "add records".
    const writes = allWrites.flatMap((w) => {
      const fields = Object.fromEntries(
        Object.entries(w.fields).filter(([id]) => editableIds.has(id))
      );
      return Object.keys(fields).length > 0 ? [{ id: w.id, fields }] : [];
    });
    const creates = canAddRecords
      ? allCreates.map((c) =>
          Object.fromEntries(Object.entries(c).filter(([id]) => settableIds.has(id)))
        )
      : [];
    const count = (rows: Fields[]) => rows.reduce((n, f) => n + Object.keys(f).length, 0);
    const skipped =
      count(writes.map((w) => w.fields)) < count(allWrites.map((w) => w.fields)) ||
      count(creates) < count(allCreates) ||
      creates.length < allCreates.length;
    if (skipped) toast("Some cells are restricted and weren't changed");
    if (writes.length === 0 && creates.length === 0) return Promise.resolve();
    return history.enqueue(async () => {
      const steps: Step[] = [];
      const step = updateStep(writes, current);
      const patched = await bulkRecords.patch(qc, table.id, writes, opts);
      // Redo writes what the server stored: option ids, not names a typecast turned into them.
      const saved = new Map(patched.records.map((r) => [r.id, r.fields]));
      if (saved.size > 0) {
        steps.push({
          ...step,
          records: step.records.flatMap((r) => {
            const stored = saved.get(r.id);
            if (!stored) return [];
            const after = Object.fromEntries(
              Object.keys(r.after).map((k) => [k, stored[k] ?? null])
            );
            return [{ ...r, after }];
          }),
        });
      }
      let error = patched.error;
      if (!error && creates.length > 0) {
        const created = await bulkRecords.create(qc, table.id, creates, opts);
        if (created.records.length > 0) {
          steps.push({ kind: 'create', recordIds: created.records.map((r) => r.id) });
        }
        error = created.error;
      }
      history.record({ label, steps });
      if (error) onWriteError(error);
    });
  };

  /** Rows `[top, bottom]` of the view, loading pages the grid hasn't. */
  const rowsOf = async (top: number, bottom: number) => {
    const getRow = await data.loadRows(top, Math.min(bottom, total - 1));
    const records: RecordData[] = [];
    for (let row = top; row <= bottom; row++) {
      const record = getRow(row);
      if (record) records.push(record);
    }
    return { getRow, records };
  };

  const byId = (records: RecordData[]) => {
    const map = new Map(records.map((r) => [r.id, r.fields]));
    return (id: string) => map.get(id);
  };

  const clearRange = async (range: Rect | null = selRange) => {
    if (!range || !canEditRecords) return;
    const { records } = await rowsOf(range.top, range.bottom);
    const writes = records.flatMap((record) => {
      const fields: Fields = {};
      for (let col = range.left; col <= range.right; col++) {
        const field = columns[col]?.field;
        if (field && editorKind(field) !== 'none' && !sameValue(record.fields[field.id], null)) {
          fields[field.id] = null;
        }
      }
      return Object.keys(fields).length > 0 ? [{ id: record.id, fields }] : [];
    });
    if (writes.length > 0) await writeRows('the clear', writes, byId(records));
  };

  const copyRange = async (range: Rect | null = selRange) => {
    if (!range) return null;
    const { records } = await rowsOf(range.top, range.bottom);
    return copyPayload(
      fieldsOf.slice(range.left, range.right + 1),
      records.map((r) => r.fields)
    );
  };

  /** Copy (and cut): synchronous when every row is loaded, else through the async API. */
  const onCopy = (e: ClipboardEvent<HTMLDivElement>, cut = false) => {
    if (editing || !selRange || !(e.target as HTMLElement).closest('[data-cell]')) return;
    e.preventDefault();
    const range = selRange;
    const rows: Fields[] = [];
    for (let row = range.top; row <= range.bottom; row++) {
      const record = data.getRow(row);
      if (!record) break;
      rows.push(record.fields);
    }
    if (rows.length === range.bottom - range.top + 1) {
      const payload = copyPayload(fieldsOf.slice(range.left, range.right + 1), rows);
      e.clipboardData.setData('text/plain', payload.text);
      e.clipboardData.setData('text/html', payload.html);
    } else {
      const payload = copyRange(range);
      void navigator.clipboard
        .write([
          new ClipboardItem({
            'text/plain': payload.then((p) => new Blob([p?.text ?? ''], { type: 'text/plain' })),
            'text/html': payload.then((p) => new Blob([p?.html ?? ''], { type: 'text/html' })),
          }),
        ])
        .catch(() => toast.error("Couldn't copy to the clipboard"));
    }
    const count = (range.bottom - range.top + 1) * (range.right - range.left + 1);
    toast(`Copied ${plural(count, 'cell')}`);
    if (cut && canEditRecords) void clearRange(range);
  };

  // A paste that would add records waits for confirmation.
  const [pendingPaste, setPendingPaste] = useState<{
    cells: PastedCell[][];
    target: Rect;
    creates: number;
  } | null>(null);

  const paste = async (cells: PastedCell[][], target: Rect, confirmed: boolean) => {
    const height = Math.max(cells.length, target.bottom - target.top + 1);
    const { getRow, records } = await rowsOf(target.top, target.top + height - 1);
    const plan = planPaste(cells, target, fieldsOf, total, (row) => getRow(row)?.fields, {
      typecast: canEditSchema,
    });
    if (plan.creates.length > 0 && !confirmed) {
      setPendingPaste({ cells, target, creates: plan.creates.length });
      return;
    }
    const writes = plan.updates.flatMap(({ row, fields }) => {
      const record = getRow(row);
      return record ? [{ id: record.id, fields }] : [];
    });
    if (plan.rows > 0 && plan.cols > 0) {
      setSel({
        anchor: { row: target.top, col: target.left },
        focus: {
          row: Math.min(target.top + plan.rows - 1, total - 1),
          col: target.left + plan.cols - 1,
        },
        mode: 'cells',
      });
    }
    if (plan.unreadable > 0) {
      toast(`${plural(plan.unreadable, 'pasted value')} couldn't be read and were skipped`);
    }
    if (writes.length > 0 || plan.creates.length > 0) {
      await writeRows('the paste', writes, byId(records), plan.creates, {
        typecast: plan.typecast,
      });
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (editing || !selRange || !(e.target as HTMLElement).closest('[data-cell]')) return;
    e.preventDefault();
    if (!canEditRecords) return;
    const cells = readClipboard(
      e.clipboardData.getData('text/plain'),
      e.clipboardData.getData('text/html')
    );
    void paste(cells, selRange, false);
  };

  /** Repeats rows `[source.top, source.bottom]` down through row `to`. */
  const fill = async (source: Rect, to: number) => {
    if (!canEditRecords || to <= source.bottom) return;
    const { getRow, records } = await rowsOf(source.top, to);
    const writes = planFill(source, to, fieldsOf, (row) => getRow(row)?.fields).flatMap(
      ({ row, fields }) => {
        const record = getRow(row);
        return record ? [{ id: record.id, fields }] : [];
      }
    );
    if (writes.length > 0) await writeRows('the fill', writes, byId(records));
  };

  /** Ctrl/⌘ D: the top row of the selection fills it; a single row takes the row above. */
  const fillDown = () => {
    if (!selRange) return;
    if (selRange.bottom > selRange.top)
      void fill({ ...selRange, bottom: selRange.top }, selRange.bottom);
    else if (selRange.top > 0)
      void fill({ ...selRange, top: selRange.top - 1, bottom: selRange.top - 1 }, selRange.top);
  };

  // The fill handle: drag the square at the selection's corner down to repeat it.
  const [fillDrag, setFillDrag] = useState<{ source: Rect; to: number } | null>(null);
  const fillDragRef = useRef(fillDrag);
  fillDragRef.current = fillDrag;
  const fillRef = useRef(fill);
  fillRef.current = fill;
  useEffect(() => {
    if (!fillDrag) return;
    const onUp = () => {
      const drag = fillDragRef.current;
      setFillDrag(null);
      if (!drag || drag.to <= drag.source.bottom) return;
      setSel({
        anchor: { row: drag.source.top, col: drag.source.left },
        focus: { row: drag.to, col: drag.source.right },
        mode: 'cells',
      });
      void fillRef.current(drag.source, drag.to);
    };
    window.addEventListener('mouseup', onUp, { once: true });
    return () => window.removeEventListener('mouseup', onUp);
  }, [fillDrag]);

  const selectedRecords = async () => {
    if (!selRange) return [];
    return (await rowsOf(selRange.top, selRange.bottom)).records;
  };

  const deleteRows = async () => {
    const records = await selectedRecords();
    if (records.length === 0) return;
    const recordIds = records.map((r) => r.id);
    const deleted = await history.enqueue(async () => {
      try {
        await bulkRecords.trash(qc, table.id, recordIds);
      } catch (err) {
        onWriteError(err);
        return false;
      }
      const label = `the deletion of ${plural(recordIds.length, 'record')}`;
      history.record({ label, steps: [{ kind: 'delete', recordIds }] });
      return true;
    });
    if (!deleted) return;
    setSel(
      cellSelection({
        row: Math.min(selRange?.top ?? 0, Math.max(0, total - recordIds.length - 1)),
        col: 0,
      })
    );
    toast(`Deleted ${plural(recordIds.length, 'record')}`, {
      action: { label: 'Undo', onClick: () => void history.undo() },
    });
  };

  const duplicateRows = async () => {
    const records = await selectedRecords();
    if (records.length === 0) return;
    const creates = records.map((r) => {
      const fields: Fields = {};
      for (const field of table.fields) {
        if (
          editorKind(field) !== 'none' &&
          r.fields[field.id] !== null &&
          r.fields[field.id] !== undefined
        ) {
          fields[field.id] = r.fields[field.id];
        }
      }
      return fields;
    });
    await writeRows(
      `the duplication of ${plural(creates.length, 'record')}`,
      [],
      () => undefined,
      creates
    );
    toast(`Duplicated ${plural(creates.length, 'record')}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || !sel) return;
    const target = e.target as HTMLElement;
    if (!target.closest('[data-cell]')) return;
    const next = navigate(sel, e, size);
    if (next) {
      e.preventDefault();
      select(next);
      return;
    }
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    const key = e.key.toLowerCase();
    if (isMod(e) && !e.altKey && (key === 'z' || key === 'y')) {
      e.preventDefault();
      if (key === 'y' || e.shiftKey) void history.redo();
      else void history.undo();
      return;
    }
    if (isMod(e) && !e.altKey && !e.shiftKey && key === 'd') {
      e.preventDefault();
      fillDown();
      return;
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEdit(sel.focus);
    } else if (e.key === 'Escape') {
      if (!isSingleCell(sel)) setSel(cellSelection(sel.focus));
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      void clearRange();
    } else if (
      e.key === ' ' &&
      !e.shiftKey &&
      columns[sel.focus.col] &&
      editorKind(columns[sel.focus.col]?.field as FieldMeta) === 'checkbox'
    ) {
      e.preventDefault();
      startEdit(sel.focus);
    } else if (e.key === ' ' && !mod && onExpandRecord) {
      // Space (Shift+Space on a checkbox) expands the record.
      e.preventDefault();
      expand(sel.focus.row);
    } else if (e.key.length === 1 && !mod) {
      e.preventDefault();
      startEdit(sel.focus, e.key);
    }
  };

  const onCellMouseDown = (cell: Cell) => (e: MouseEvent) => {
    // A right click inside the selection keeps it, for the context menu.
    if (e.button === 2 && selRange && inRange(selRange, cell.row, cell.col)) {
      e.preventDefault();
      return;
    }
    if (e.shiftKey && sel) {
      e.preventDefault();
      setSel({ anchor: sel.anchor, focus: cell, mode: 'cells' });
    } else {
      setSel(cellSelection(cell));
    }
    pendingFocus.current = cell;
  };

  const addRecord = () => {
    const at = total;
    create.mutate(
      { fields: {} },
      {
        onSuccess: () => {
          const cell = { row: at, col: 0 };
          setSel(cellSelection(cell));
          scrollToCell(cell);
        },
        onError: onWriteError,
      }
    );
  };

  // The record expand view.
  const [expandLayout, setExpandLayout] = useState<ExpandLayout>(() =>
    storedLayout(typeof window === 'undefined' ? undefined : window.localStorage)
  );
  const expand = (row: number) => {
    const record = data.getRow(row);
    if (record && onExpandRecord) onExpandRecord(record.id);
  };
  // On touch screens a tap on the active cell opens the record sheet on that cell's field.
  const [expandFocus, setExpandFocus] = useState<{ recordId: string; fieldId: string } | null>(
    null
  );
  const lastPointer = useRef<string>('mouse');
  const tapOnActive = useRef(false);
  const openSheet = (cell: Cell) => {
    const record = data.getRow(cell.row);
    const column = columns[cell.col];
    if (!record || !column || !onExpandRecord) return;
    setExpandFocus({ recordId: record.id, fieldId: column.field.id });
    onExpandRecord(record.id);
  };
  // Stepping to a record the grid hasn't loaded yet scrolls there and opens it once loaded.
  const [pendingExpand, setPendingExpand] = useState<number | null>(null);
  const expandAt = (row: number) => {
    setExpandFocus(null);
    const col = sel?.focus.col ?? 0;
    setSel(cellSelection({ row, col }));
    rowV.scrollToIndex(row, { align: 'auto' });
    if (data.getRow(row)) expand(row);
    else setPendingExpand(row);
  };
  const pendingRecordId = pendingExpand === null ? undefined : data.getRow(pendingExpand)?.id;
  useEffect(() => {
    if (pendingRecordId && onExpandRecord) {
      onExpandRecord(pendingRecordId);
      setPendingExpand(null);
    }
  }, [pendingRecordId, onExpandRecord]);
  const deleteRecord = useDeleteRecordWithUndo(table.id);
  const expandedIndex = expandedRecordId ? data.indexOf(expandedRecordId) : null;
  const closeExpand = () => {
    setExpandFocus(null);
    onExpandRecord?.(null);
    // Back to the grid, on the record's row.
    if (sel) pendingFocus.current = sel.focus;
  };

  const actions: ColumnActions = {
    resize: (fieldId, width, commit) => {
      const columnWidths = { ...layout.columnWidths, [fieldId]: width };
      if (commit) save({ columnWidths });
      else preview({ columnWidths });
    },
    move: (fieldId, toIndex) =>
      save({ fieldOrder: mergeOrder(fullOrder, moveField(columns, fieldId, toIndex)) }),
    freezeThrough: (index) => save({ frozenCount: Math.min(10, Math.max(0, index)) }),
    selectColumn: (index) => {
      setSel(selectColumns(null, index, false));
      pendingFocus.current = { row: Math.max(0, first), col: index };
    },
    ...fieldManagement.actions,
    editPermissions: setPermissionsField,
  };
  const lockOf = (field: FieldMeta) =>
    field.synced
      ? { editable: false, synced: true }
      : isLockedField(table, field)
        ? { editable: canEditCell(field) }
        : undefined;
  const frozenThrough = frozen.length - 1;

  const renderCell = (
    column: GridColumn,
    colIndex: number,
    rowIndex: number,
    record: RecordData | undefined,
    style?: React.CSSProperties
  ) => {
    const cell = { row: rowIndex, col: colIndex };
    const isActive = active?.row === rowIndex && active.col === colIndex;
    const selected = selRange ? inRange(selRange, rowIndex, colIndex) : false;
    const isEditing = editing?.cell.row === rowIndex && editing.cell.col === colIndex;
    const tabbable = active ? isActive : rowIndex === 0 && colIndex === 0;
    const value = record?.fields[column.field.id];
    const error = record ? cellErrors.get(errorKey(record.id, column.field.id)) : undefined;
    const kind = editorKind(column.field);
    const cellEditable = canEditCell(column.field);
    const inPlace = cellEditable && (kind === 'checkbox' || kind === 'rating');
    const canDrop = cellEditable && kind === 'attachment' && record !== undefined;
    const dropping = canDrop && dropCell === cellKey(cell);
    const fillTarget =
      fillDrag !== null &&
      rowIndex > fillDrag.source.bottom &&
      rowIndex <= fillDrag.to &&
      colIndex >= fillDrag.source.left &&
      colIndex <= fillDrag.source.right;
    const showFillHandle =
      canEditRecords &&
      sel?.mode === 'cells' &&
      !editing &&
      !fillDrag &&
      selRange?.bottom === rowIndex &&
      selRange.right === colIndex;
    const peerKey = record ? cellKeyOf(record.id, column.field.id) : undefined;
    const peers = peerKey ? peerCells.get(peerKey) : undefined;
    const match =
      search !== '' &&
      record !== undefined &&
      cellText(column.field, value).toLowerCase().includes(search.toLowerCase());
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the grid's onKeyDown handles the keys (Enter edits)
      <div
        key={column.field.id}
        role="gridcell"
        aria-colindex={colIndex + 2}
        aria-selected={selected}
        aria-invalid={error ? true : undefined}
        aria-describedby={peers && peerKey ? peerDescriptions.describedBy(peerKey) : undefined}
        data-cell={cellKey(cell)}
        data-match={match || undefined}
        tabIndex={tabbable ? 0 : -1}
        onMouseDown={onCellMouseDown(cell)}
        onMouseEnter={(e) => {
          if (fillDrag) {
            const to = Math.max(fillDrag.source.bottom, rowIndex);
            if (to !== fillDrag.to) setFillDrag({ ...fillDrag, to });
            return;
          }
          if (e.buttons === 1 && sel && !editing)
            setSel({ anchor: sel.anchor, focus: cell, mode: 'cells' });
        }}
        onContextMenu={() => {
          if (!selRange || !inRange(selRange, rowIndex, colIndex)) setSel(cellSelection(cell));
        }}
        onPointerDown={(e) => {
          lastPointer.current = e.pointerType;
          tapOnActive.current = e.pointerType === 'touch' && isActive && !editing;
        }}
        onClick={() => {
          // Tap to select, tap again (or double-tap) to edit in the record sheet.
          if (!tapOnActive.current) return;
          tapOnActive.current = false;
          if (!inPlace) openSheet(cell);
        }}
        onDoubleClick={() => {
          // A double-tap already opened the sheet; no inline editor on touch.
          if (lastPointer.current === 'touch') return;
          if (!inPlace) startEdit(cell);
        }}
        onDragOver={(e) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          if (!canDrop) {
            e.dataTransfer.dropEffect = 'none';
            return;
          }
          e.dataTransfer.dropEffect = 'copy';
          if (dropCell !== cellKey(cell)) setDropCell(cellKey(cell));
        }}
        onDragLeave={() => {
          if (dropCell === cellKey(cell)) setDropCell(null);
        }}
        onDrop={(e) => {
          if (!dragHasFiles(e)) return;
          e.preventDefault();
          e.stopPropagation();
          setDropCell(null);
          if (canDrop) void dropFiles(cell, [...e.dataTransfer.files]);
        }}
        onFocus={() => {
          if (!active || active.row !== rowIndex || active.col !== colIndex)
            setSel(cellSelection(cell));
        }}
        className={cn(
          'group/cell relative flex h-full shrink-0 items-center overflow-hidden border-r border-b border-border px-2 outline-none',
          column.field.isPrimary && 'font-[550]',
          column.align === 'right' && 'justify-end',
          column.align === 'center' && 'justify-center',
          colIndex === frozenThrough && 'border-r-border-strong',
          match && 'bg-[var(--chip-amber-bg)]',
          (selected || fillTarget) && !isActive && 'bg-primary/8',
          (fillTarget || dropping) && 'outline-1 -outline-offset-1 outline-dashed outline-primary',
          dropping && 'bg-primary/8',
          isActive && 'outline-2 -outline-offset-2 outline-primary'
        )}
        style={{ width: column.width, ...style }}
      >
        {isEditing && editing && record ? (
          <CellEditor
            field={column.field}
            value={value}
            initialText={editing.initialText}
            align={column.align}
            canAddOptions={canEditSchema}
            onCommit={commitEdit}
            onCancel={() => commitEdit(null, 'stay')}
          />
        ) : record ? (
          <CellContent
            field={column.field}
            value={value}
            onChange={inPlace ? (v) => writeCell(cell, v) : undefined}
            button={{ tableId: table.id, recordId: record.id }}
          />
        ) : (
          <span className="h-2.5 w-2/3 rounded-xs bg-hover" />
        )}
        {peers && <PeerCellMarker here={peers} />}
        {showFillHandle && (
          <span
            data-testid="fill-handle"
            aria-hidden
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (selRange) setFillDrag({ source: selRange, to: selRange.bottom });
            }}
            className="absolute right-0 bottom-0 z-10 size-[7px] cursor-crosshair border border-surface bg-primary"
          />
        )}
        {error && !isEditing && (
          <span
            role="img"
            aria-label={`Couldn't save: ${error}`}
            title={`Couldn't save: ${error}`}
            className="absolute top-0.5 right-0.5 flex rounded-full bg-surface text-danger"
          >
            <CircleAlert className="size-3.5" aria-hidden />
          </span>
        )}
      </div>
    );
  };

  const scrollCellsOf = (
    render: (column: GridColumn, colIndex: number, left: number) => ReactNode
  ) =>
    virtualCols.map((vc) => {
      const column = scrolling[vc.index];
      return column ? render(column, vc.index + frozen.length, vc.start) : null;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewToolbar
        fields={orderedFields(table.fields, layout)}
        hidden={hidden}
        onHiddenChange={(hiddenFields) => save({ hiddenFields })}
        onOrderChange={(fieldOrder) => save({ fieldOrder })}
        query={viewQuery.query}
        onQueryChange={viewQuery.change}
        rowHeight={layout.rowHeight ?? 'default'}
        onRowHeightChange={(h) => save({ rowHeight: h })}
        rowColor={rowColor.rowColor}
        onRowColorChange={rowColor.change}
        find={find}
        count={
          data.isPending ? '' : `${total.toLocaleString()} ${total === 1 ? 'record' : 'records'}`
        }
        exportHref={downloadUrl(downloads.tableCsv, {
          params: { tableId: table.id },
          query: {
            viewId: view?.id,
            query: JSON.stringify({ ...applied, fields: columns.map((c) => c.field.id) }),
          },
        })}
        onImport={canEditRecords ? () => setImporting(true) : undefined}
      />
      <ImportDialog
        table={table}
        open={importing}
        onOpenChange={(open) => {
          setImporting(open);
          if (!open) setImportFile(undefined);
        }}
        canCreateFields={canEditSchema}
        initialFile={importFile}
      />
      {peerDescriptions.node}
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!sel}>
          <div
            ref={scrollRef}
            role="grid"
            aria-label={view?.name ?? 'Grid'}
            aria-rowcount={total + 1}
            aria-colcount={columns.length + 1}
            aria-multiselectable
            onKeyDown={onKeyDown}
            onCopy={(e) => onCopy(e)}
            onCut={(e) => onCopy(e, true)}
            onPaste={onPaste}
            onDragOver={(e) => {
              if (dragHasFiles(e)) e.preventDefault();
            }}
            onDrop={(e) => {
              if (dragHasFiles(e)) e.preventDefault();
            }}
            data-testid="grid"
            className="tnum relative min-h-0 flex-1 touch-manipulation overflow-auto overscroll-contain bg-surface text-body"
          >
            {/* At least as wide as the grid, so the summary bar reaches its edge. */}
            <div className="flex min-h-full min-w-full flex-col" style={{ width: totalWidth }}>
              {/* Header */}
              <div
                role="row"
                aria-rowindex={1}
                className="sticky top-0 z-20 flex shrink-0 bg-header"
                style={{ height: HEADER_HEIGHT, width: totalWidth }}
              >
                <div
                  className="sticky left-0 z-10 flex h-full bg-header"
                  style={{ width: frozenWidth }}
                >
                  <div
                    role="columnheader"
                    aria-colindex={1}
                    className="flex h-full shrink-0 items-center justify-center border-r border-b border-border text-text-2"
                    style={{ width: GUTTER_WIDTH }}
                  >
                    #
                  </div>
                  {frozen.map((column, i) => (
                    <ColumnHeader
                      key={column.field.id}
                      column={column}
                      index={i}
                      frozenThrough={frozenThrough}
                      canReorder={canEditRecords}
                      canEditSchema={canEditSchema}
                      lock={lockOf(column.field)}
                      actions={actions}
                    />
                  ))}
                </div>
                {scrollCellsOf((column, colIndex, left) => (
                  <div key={column.field.id} className="absolute top-0 h-full" style={{ left }}>
                    <ColumnHeader
                      column={column}
                      index={colIndex}
                      frozenThrough={frozenThrough}
                      canReorder={canEditRecords}
                      canEditSchema={canEditSchema}
                      lock={lockOf(column.field)}
                      actions={actions}
                    />
                  </div>
                ))}
                <div
                  className="absolute top-0 h-full border-b border-border"
                  style={{ left: frozenWidth + scrollWidth, width: ADD_COLUMN_WIDTH }}
                >
                  {canEditSchema && <AddFieldButton table={table} />}
                </div>
              </div>

              {/* Rows */}
              <div
                className="relative shrink-0"
                style={{ height: rowV.getTotalSize() + rowHeight }}
              >
                {virtualRows.map((vr) => {
                  const record = data.getRow(vr.index);
                  const rowSelected =
                    sel?.mode === 'rows' && selRange
                      ? vr.index >= selRange.top && vr.index <= selRange.bottom
                      : false;
                  const color = rowColorOf(record, rowColor.rowColor, table.fields, data.rowColors);
                  const band = headers.get(vr.index);
                  const top = vr.start - HEADER_HEIGHT + bandOf(vr.index);
                  return [
                    band && (
                      <GroupBands
                        key={`band-${vr.key}`}
                        headers={band}
                        groupBy={groupBy}
                        fields={table.fields}
                        top={vr.start - HEADER_HEIGHT}
                        width={totalWidth}
                        frozenWidth={frozenWidth}
                      />
                    ),
                    <div
                      key={vr.key}
                      role="row"
                      aria-rowindex={vr.index + 2}
                      aria-selected={rowSelected}
                      data-row-color={color}
                      className="group absolute left-0 flex bg-surface hover:bg-hover"
                      style={{ top, height: rowHeight, width: totalWidth }}
                    >
                      <div
                        className="sticky left-0 z-10 flex h-full bg-inherit"
                        style={{ width: frozenWidth }}
                      >
                        <div
                          role="rowheader"
                          aria-colindex={1}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setSel(selectRows(sel, vr.index, e.shiftKey));
                            pendingFocus.current = { row: vr.index, col: 0 };
                          }}
                          className={cn(
                            'relative flex h-full shrink-0 cursor-default items-center justify-center border-r border-b border-border text-small text-text-2',
                            rowSelected && 'bg-selected text-text'
                          )}
                          style={{
                            width: GUTTER_WIDTH,
                            ...(color && !rowSelected
                              ? { background: `var(--chip-${color}-bg)` }
                              : {}),
                          }}
                        >
                          {color && (
                            <span
                              aria-hidden
                              className="absolute left-1.5 size-2 rounded-full"
                              style={{ background: `var(--chip-${color})` }}
                            />
                          )}
                          <span
                            className={cn(
                              record && onExpandRecord && (touch ? 'hidden' : 'group-hover:hidden'),
                              record && commentCounts?.[record.id] && '-translate-x-2'
                            )}
                          >
                            {vr.index + 1}
                          </span>
                          {record && commentCounts?.[record.id] && (
                            <span
                              data-testid="comment-count"
                              title={`${commentCounts[record.id]} ${commentCounts[record.id] === 1 ? 'comment' : 'comments'}`}
                              className="pointer-events-none absolute right-1 flex items-center gap-px text-[10px] leading-none text-text-2"
                            >
                              <MessageSquare className="size-2.5" aria-hidden />
                              <span className="sr-only">Comments: </span>
                              {commentCounts[record.id]}
                            </span>
                          )}
                          {record && onExpandRecord && (
                            <button
                              type="button"
                              tabIndex={-1}
                              aria-label={`Expand record ${vr.index + 1}`}
                              title="Expand record (Space)"
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={() => {
                                setSel(cellSelection({ row: vr.index, col: 0 }));
                                onExpandRecord(record.id);
                              }}
                              className={cn(
                                'rounded-xs p-1 text-text-2 hover:bg-selected hover:text-text',
                                // Always shown on touch screens: the row number and a 40 px target.
                                touch
                                  ? 'flex h-[40px] w-full items-center justify-center gap-1'
                                  : 'hidden group-hover:flex'
                              )}
                            >
                              {touch && vr.index + 1}
                              <Maximize2 className={touch ? 'size-3' : 'size-3.5'} aria-hidden />
                            </button>
                          )}
                        </div>
                        {frozen.map((column, i) => renderCell(column, i, vr.index, record))}
                      </div>
                      {scrollCellsOf((column, colIndex, left) =>
                        renderCell(column, colIndex, vr.index, record, {
                          position: 'absolute',
                          top: 0,
                          left,
                        })
                      )}
                    </div>,
                  ];
                })}
                {/* The "+" row */}
                {canAddRecords && (
                  <div
                    className="absolute left-0 flex"
                    style={{ top: rowV.getTotalSize(), height: rowHeight, width: totalWidth }}
                  >
                    <div
                      className="sticky left-0 z-10 flex h-full bg-surface"
                      style={{ width: frozenWidth }}
                    >
                      <button
                        type="button"
                        onClick={addRecord}
                        aria-label="Add record"
                        className="flex h-full w-full items-center gap-2 border-b border-border px-4 text-text-2 hover:bg-hover hover:text-text"
                      >
                        <Plus className="size-4" aria-hidden />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Summary bar: the grid's whole width (the footer bar, DESIGN.md), the aggregates
                  under their columns. */}
              <div
                className="sticky bottom-0 z-20 mt-auto flex shrink-0 border-t border-border bg-header"
                style={{ height: FOOTER_HEIGHT }}
                data-testid="summary-bar"
              >
                <div
                  className="sticky left-0 z-10 flex h-full items-center bg-header"
                  style={{ width: frozenWidth }}
                >
                  <span className="truncate px-4 text-small text-text-2">
                    {total.toLocaleString()} {total === 1 ? 'record' : 'records'}
                  </span>
                </div>
                {scrollCellsOf((column, _i, left) => {
                  const summary = summaryFor(column.field);
                  const values = summary ? data.aggregates?.[column.field.id] : undefined;
                  const value = values?.[summary?.fn ?? ''];
                  if (!summary || value === undefined || value === null) return null;
                  const text =
                    summary.fn === 'filled'
                      ? `Checked ${Number(value).toLocaleString()}/${total.toLocaleString()}`
                      : `Sum ${cellText(column.field, value)}`;
                  return (
                    <div
                      key={column.field.id}
                      title={text}
                      className="absolute top-0 truncate px-2 text-right text-small text-text-2"
                      style={{ left, width: column.width, lineHeight: `${FOOTER_HEIGHT}px` }}
                    >
                      {text}
                    </div>
                  );
                })}
              </div>
            </div>
            {data.isError && (
              <p role="alert" className="px-4 py-10 text-center text-danger">
                Couldn't load the records.
              </p>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => {
            // Back to the active cell, not the grid container.
            e.preventDefault();
            if (sel) scrollToCell(sel.focus);
          }}
        >
          <ContextMenuItem
            onSelect={() => {
              void copyRange().then((p) =>
                p
                  ? navigator.clipboard
                      .write([
                        new ClipboardItem({
                          'text/plain': new Blob([p.text], { type: 'text/plain' }),
                          'text/html': new Blob([p.html], { type: 'text/html' }),
                        }),
                      ])
                      .then(() => toast('Copied'))
                  : undefined
              );
            }}
          >
            <Copy aria-hidden /> Copy
          </ContextMenuItem>
          {canEditRecords && (
            <>
              <ContextMenuItem onSelect={fillDown}>
                <ArrowDownToLine aria-hidden /> Fill down
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void clearRange()}>
                <Eraser aria-hidden /> Clear cells
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={!canAddRecords} onSelect={() => void duplicateRows()}>
                <CopyPlus aria-hidden />
                Duplicate {selRange ? plural(selRange.bottom - selRange.top + 1, 'record') : ''}
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                disabled={!canDeleteRecords}
                onSelect={() => void deleteRows()}
              >
                <Trash2 aria-hidden />
                Delete {selRange ? plural(selRange.bottom - selRange.top + 1, 'record') : ''}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <Dialog open={pendingPaste !== null} onOpenChange={(open) => !open && setPendingPaste(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add {plural(pendingPaste?.creates ?? 0, 'record')}?</DialogTitle>
            <DialogDescription>
              The pasted data goes past the last record. Pasting adds{' '}
              {plural(pendingPaste?.creates ?? 0, 'new record')} for the rest.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setPendingPaste(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              autoFocus
              onClick={() => {
                const pending = pendingPaste;
                setPendingPaste(null);
                if (pending) void paste(pending.cells, pending.target, true);
              }}
            >
              Add records
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {fieldManagement.ui}
      {permissionsField && (
        <FieldPermissionsDialog
          table={table}
          field={permissionsField}
          onClose={() => setPermissionsField(null)}
        />
      )}
      {expandedRecordId && (
        <RecordExpand
          key={expandedRecordId}
          table={table}
          fields={orderedFields(table.fields, layout)}
          hidden={hidden}
          recordId={expandedRecordId}
          cached={expandedIndex === null ? undefined : data.getRow(expandedIndex)}
          index={expandedIndex}
          total={total}
          userRole={role}
          canEdit={canEditRecords}
          layout={expandLayout}
          onLayoutChange={(l) => {
            setExpandLayout(l);
            storeLayout(window.localStorage, l);
          }}
          onNavigate={expandAt}
          onClose={closeExpand}
          onDelete={deleteRecord}
          focusFieldId={
            expandFocus?.recordId === expandedRecordId ? expandFocus.fieldId : undefined
          }
        />
      )}
    </div>
  );
}

/**
 * The group headers above the first record of a group: one band per level that starts
 * there, indented by level, with the group's value and record count. The label stays in view
 * when scrolling sideways.
 */
function GroupBands({
  headers,
  groupBy,
  fields,
  top,
  width,
  frozenWidth,
}: {
  headers: GroupHeader[];
  groupBy: readonly { fieldId: string }[];
  fields: FieldMeta[];
  top: number;
  width: number;
  frozenWidth: number;
}) {
  return (
    <div className="absolute left-0" style={{ top, width }}>
      {headers.map((h) => {
        const field = fields.find((f) => f.id === groupBy[h.level]?.fieldId);
        const empty = h.key === null || h.key === undefined || h.key === '';
        return (
          <div
            key={h.level}
            data-testid="group-header"
            className="flex items-end border-b border-border bg-header"
            style={{ height: GROUP_HEADER_HEIGHT }}
          >
            <div
              className="sticky left-0 flex items-center gap-2 truncate pb-1"
              style={{ paddingLeft: 12 + h.level * 16, maxWidth: Math.max(frozenWidth, 320) }}
            >
              <span className="text-small text-text-2">{field?.name}</span>
              <span className="flex min-w-0 items-center truncate font-[550]">
                {field && !empty ? <CellContent field={field} value={h.key} /> : '(empty)'}
              </span>
              <span className="tnum text-small text-text-2">
                {h.count.toLocaleString()} {h.count === 1 ? 'record' : 'records'}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
