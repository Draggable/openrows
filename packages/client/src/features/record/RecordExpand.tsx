import type { FieldMeta, LinkOptions, RecordData, TableMeta, UserRole } from '@openrows/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Ellipsis,
  Link2,
  PanelRight,
  SquareStack,
  Trash2,
  X,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { commentQueries, recordQueries, tableQueries, viewQueries } from '../../api/queries';
import { useDeleteRecords, useRestoreRecords, useUpdateRecord } from '../../api/records';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  Tooltip,
  toast,
} from '../../components/ui';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/media';
import { cn } from '../../lib/utils';
import { AiRecordValue } from '../ai-fields/AiCell';
import { FIELD_TYPE_ICONS } from '../fields/icons';
import {
  buttonTarget,
  CellContent,
  CellEditor,
  cellText,
  type EditorMove,
  type EditorResult,
  editorKind,
  fieldDef,
  LinkChip,
  linkItems,
  opensEditor,
  RichText,
  sameValue,
} from '../grid/cells';
import { useEditRights } from '../permissions/model';
import { RecordViewers } from '../realtime/Presence';
import { ActivityPanel } from './activity/ActivityPanel';
import { CommentsPanel } from './comments/CommentsPanel';
import {
  type ExpandLayout,
  navigationKey,
  neighbour,
  positionLabel,
  recordUrl,
  relativeTime,
  shortDate,
} from './model';

export interface RecordExpandProps {
  table: TableMeta;
  /** Every live field in the view's order; `hidden` ones are listed after the others. */
  fields: FieldMeta[];
  hidden: readonly string[];
  recordId: string;
  /** The record as the grid holds it (kept current by the optimistic caches). */
  cached: RecordData | undefined;
  /** Its position in the view, `null` when the grid hasn't loaded it (a deep link far down). */
  index: number | null;
  total: number;
  canEdit: boolean;
  /** The user's role, for the table and field edit permissions. */
  userRole: UserRole | undefined;
  layout: ExpandLayout;
  onLayoutChange: (layout: ExpandLayout) => void;
  onNavigate: (index: number) => void;
  onClose: () => void;
  /** Deletes the record (see `useDeleteRecordWithUndo`); the view closes first. */
  onDelete: (recordId: string, name: string) => void;
  /** The field to open in its editor (or focus) once shown: the cell tapped in the grid. */
  focusFieldId?: string | undefined;
}

/** Wide enough for the fields and the comments side by side (DESIGN.md, record modal). */
const TWO_COLUMN_QUERY = '(min-width: 1100px)';

const message = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.message : fallback;

/**
 * Deletes a record with an "Undo" toast that restores it. Owned by the grid, which outlives the
 * expand view (mutate callbacks don't run once their component unmounts).
 */
export function useDeleteRecordWithUndo(tableId: string) {
  const remove = useDeleteRecords(tableId);
  const restore = useRestoreRecords(tableId);
  return (recordId: string, name: string) =>
    remove.mutate([recordId], {
      onSuccess: () =>
        toast(`Deleted "${name}"`, {
          action: {
            label: 'Undo',
            onClick: () =>
              restore.mutate([recordId], {
                onSuccess: () => toast.success(`Restored "${name}"`),
                onError: (err) => toast.error(message(err, "Couldn't restore the record")),
              }),
          },
        }),
      onError: (err) => toast.error(message(err, "Couldn't delete the record")),
    });
}

/**
 * The expanded record (mockup b): every field with its editor, previous/next through
 * the view (↑/↓ or K/J, the arrow buttons), a copyable link (`?record=<id>`), delete with undo,
 * and a modal or right-docked panel layout. Esc closes. Below 768 px it is always a full-screen
 * sheet.
 */
export function RecordExpand(props: RecordExpandProps) {
  const rights = useEditRights(props.table, props.userRole);
  const { table, recordId, cached, index, total, layout, onClose } = props;
  const detail = useQuery({
    ...recordQueries.detail(table.id, recordId),
    enabled: cached === undefined,
    retry: false,
  });
  const record = cached ?? detail.data;
  const primary = props.fields.find((f) => f.isPrimary);
  const title = record && primary ? cellText(primary, record.fields[primary.id]) : '';
  const [editing, setEditing] = useState<string | null>(null);

  const prev = neighbour(index, total, -1);
  const next = neighbour(index, total, 1);

  const copyLink = async () => {
    const url = recordUrl(window.location.origin, window.location.pathname, recordId);
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const deleteRecord = () => {
    onClose();
    props.onDelete(recordId, title || 'Unnamed record');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (editing) return;
    const step = navigationKey(e);
    const target = step === -1 ? prev : step === 1 ? next : null;
    if (step !== null) e.preventDefault();
    if (target !== null) props.onNavigate(target);
  };

  const visible = props.fields.filter((f) => !props.hidden.includes(f.id));
  const hiddenFields = props.fields.filter((f) => props.hidden.includes(f.id));
  const notFound = !record && detail.isError;
  const mobile = useMediaQuery(MOBILE_QUERY);
  const panel = layout === 'panel' && !mobile;
  // Comments and Activity: beside the fields in a wide modal (DESIGN.md), with their
  // own tabs there, else tabs next to Fields.
  const wide = useMediaQuery(TWO_COLUMN_QUERY);
  const twoColumn = !panel && !mobile && wide;
  // A notification's deep link (`&comment=<id>`) opens the comments at that comment.
  const [focusComment] = useState(commentFromUrl);
  const [tab, setTab] = useState<RecordTab>(focusComment ? 'comments' : 'fields');
  // The side column's tab in the two-column layout.
  const [side, setSide] = useState<'comments' | 'activity'>('comments');
  const shown: RecordTab = twoColumn ? side : tab;
  const comments = useQuery({
    ...commentQueries.record(table.id, recordId),
    enabled: record !== undefined,
  });
  const commentCount = comments.data?.comments.length;

  return (
    <DialogPrimitive.Root
      open
      modal={!panel}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {!panel && <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim" />}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-testid="record-expand"
          data-layout={layout}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            // Focus the view itself, not the first button (whose tooltip would then show).
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onEscapeKeyDown={(e) => {
            // Esc first closes an open editor (or the comment box's suggestions or edit).
            const focused = document.activeElement as HTMLElement | null;
            if (editing || focused?.closest('[data-keeps-escape="true"]')) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            // The side panel stays open while the grid is used.
            if (panel) e.preventDefault();
          }}
          className={cn(
            'fixed z-40 flex flex-col border border-border bg-surface text-body text-text shadow-3 outline-none',
            panel
              ? 'top-0 right-0 h-full w-full max-w-[520px] border-y-0 border-r-0'
              : cn(
                  'top-1/2 left-1/2 max-h-[min(860px,calc(100vh-48px))] w-[calc(100vw-48px)] -translate-x-1/2 -translate-y-1/2 rounded-lg',
                  twoColumn ? 'h-[min(860px,calc(100vh-48px))] max-w-[1180px]' : 'max-w-[760px]'
                ),
            mobile &&
              'inset-0 h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]'
          )}
        >
          <header className="flex shrink-0 flex-col gap-2 px-4 pt-4 pb-3 md:px-6">
            <div className="flex items-center gap-2">
              <p className="min-w-0 truncate text-text-2">
                {table.name} ·{' '}
                <span data-testid="record-position">{positionLabel(index, total)}</span>
              </p>
              <Tooltip content="Previous record (↑ or K)">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Previous record"
                  disabled={prev === null}
                  onClick={() => prev !== null && props.onNavigate(prev)}
                >
                  <ChevronUp className="size-4" aria-hidden />
                </Button>
              </Tooltip>
              <Tooltip content="Next record (↓ or J)">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Next record"
                  disabled={next === null}
                  onClick={() => next !== null && props.onNavigate(next)}
                >
                  <ChevronDown className="size-4" aria-hidden />
                </Button>
              </Tooltip>
              <div className="ml-auto flex items-center gap-1">
                <RecordViewers recordId={recordId} />
                <Tooltip content="Copy record link">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Copy record link"
                    onClick={copyLink}
                  >
                    <Link2 className="size-4" aria-hidden />
                  </Button>
                </Tooltip>
                <Tooltip content={panel ? 'Show as a modal' : 'Show as a side panel'}>
                  <Button
                    className={cn(mobile && 'hidden')}
                    variant="ghost"
                    size="icon"
                    aria-label={panel ? 'Show as a modal' : 'Show as a side panel'}
                    onClick={() => props.onLayoutChange(panel ? 'modal' : 'panel')}
                  >
                    {panel ? (
                      <SquareStack className="size-4" aria-hidden />
                    ) : (
                      <PanelRight className="size-4" aria-hidden />
                    )}
                  </Button>
                </Tooltip>
                {props.canEdit && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="More record actions">
                        <Ellipsis className="size-4" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={copyLink}>
                        <Link2 className="size-4" aria-hidden />
                        Copy record link
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-danger"
                        disabled={!rights.canDelete}
                        onSelect={deleteRecord}
                      >
                        <Trash2 className="size-4" aria-hidden />
                        Delete record
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <DialogPrimitive.Close asChild>
                  <Button variant="ghost" size="sm" aria-label="Close" className="gap-1.5">
                    <X className="size-4" aria-hidden />
                    <kbd className="rounded-xs border border-border px-1 text-small text-text-2 pointer-coarse:hidden">
                      Esc
                    </kbd>
                  </Button>
                </DialogPrimitive.Close>
              </div>
            </div>
            <DialogPrimitive.Title
              className={cn('truncate text-title font-semibold', !title && record && 'text-text-3')}
            >
              {record ? title || 'Unnamed record' : notFound ? 'Record not found' : 'Loading…'}
            </DialogPrimitive.Title>
          </header>

          {record && !twoColumn && (
            <RecordTabs
              tabs={['fields', 'comments', 'activity']}
              current={tab}
              onSelect={setTab}
              commentCount={commentCount}
              className="px-4 md:px-6"
            />
          )}

          <div className="flex min-h-0 flex-1 border-t border-border">
            <div
              className={cn(
                'min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2 md:px-6',
                record && !twoColumn && tab !== 'fields' && 'hidden'
              )}
            >
              {record ? (
                <>
                  <FieldList {...props} fields={visible} record={record} setEditing={setEditing} />
                  {hiddenFields.length > 0 && (
                    <>
                      <h3 className="mt-4 mb-1 text-small text-text-2">Hidden in this view</h3>
                      <FieldList
                        {...props}
                        fields={hiddenFields}
                        record={record}
                        setEditing={setEditing}
                      />
                    </>
                  )}
                </>
              ) : notFound ? (
                <p role="alert" className="py-10 text-center text-text-2">
                  This record was deleted or you don't have access to it.
                </p>
              ) : (
                <div className="grid gap-3 py-3" aria-busy="true">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-8" />
                  ))}
                </div>
              )}
            </div>
            {record && (twoColumn || tab !== 'fields') && (
              <div
                className={cn(
                  'flex min-h-0 flex-col bg-app',
                  twoColumn ? 'w-[35%] min-w-[320px] border-l border-border' : 'flex-1'
                )}
              >
                {twoColumn && (
                  <RecordTabs
                    tabs={['comments', 'activity']}
                    current={side}
                    onSelect={(t) => setSide(t === 'activity' ? 'activity' : 'comments')}
                    commentCount={commentCount}
                    className="border-b border-border px-4"
                  />
                )}
                {shown === 'activity' ? (
                  <ActivityPanel
                    table={table}
                    fields={props.fields}
                    recordId={recordId}
                    userRole={props.userRole}
                    className="flex-1"
                  />
                ) : (
                  <CommentsPanel
                    tableId={table.id}
                    recordId={recordId}
                    userRole={props.userRole}
                    showHeading={false}
                    className="flex-1"
                    focusCommentId={focusComment}
                  />
                )}
              </div>
            )}
          </div>

          {record && (
            <footer className="flex h-12 shrink-0 items-center border-t border-border px-4 text-small text-text-2 md:px-6">
              <span title={record.createdAt}>Created {shortDate(record.createdAt)}</span>
              <span className="px-2">·</span>
              <span title={record.updatedAt}>Edited {relativeTime(record.updatedAt)}</span>
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

type RecordTab = 'fields' | 'comments' | 'activity';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `comment` search parameter of the page's URL, when it is a UUID. */
function commentFromUrl(): string | undefined {
  const id = new URLSearchParams(window.location.search).get('comment');
  return id && UUID_RE.test(id) ? id.toLowerCase() : undefined;
}

const TAB_LABELS: Record<RecordTab, string> = {
  fields: 'Fields',
  comments: 'Comments',
  activity: 'Activity',
};

/** The record's tabs (DESIGN.md: a 2 px underline on the active one). */
function RecordTabs({
  tabs,
  current,
  onSelect,
  commentCount,
  className,
}: {
  tabs: readonly RecordTab[];
  current: RecordTab;
  onSelect: (tab: RecordTab) => void;
  commentCount: number | undefined;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label="Record" className={cn('flex shrink-0 gap-4', className)}>
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={current === t}
          onClick={() => onSelect(t)}
          className={cn(
            '-mb-px flex h-9 items-center gap-1.5 border-b-2 border-transparent text-text-2 outline-none hover:text-text focus-visible:text-text',
            current === t && 'border-primary font-semibold text-text'
          )}
        >
          {TAB_LABELS[t]}
          {t === 'comments' && commentCount !== undefined && (
            <span
              data-testid="comments-count"
              className="rounded-xs border border-border px-1 text-small font-normal text-text-2"
            >
              {commentCount}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function FieldList({
  table,
  fields,
  record,
  canEdit,
  userRole,
  setEditing,
  focusFieldId,
}: RecordExpandProps & {
  record: RecordData;
  setEditing: (fieldId: string | null) => void;
}) {
  const update = useUpdateRecord(table.id);
  const rights = useEditRights(table, userRole);
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const setError = (fieldId: string, error: string | null) =>
    setErrors((prev) => {
      const next = new Map(prev);
      if (error === null) next.delete(fieldId);
      else next.set(fieldId, error);
      return next;
    });

  const save = (field: FieldMeta, value: unknown, typecast?: boolean) => {
    if (sameValue(value, record.fields[field.id])) return;
    setError(field.id, null);
    update.mutate(
      { recordId: record.id, fields: { [field.id]: value }, ...(typecast ? { typecast } : {}) },
      {
        onError: (err) => {
          const text = message(err, "Couldn't save the change");
          setError(field.id, text);
          toast.error(text);
        },
      }
    );
  };

  return (
    <dl className="divide-y divide-border">
      {fields.map((field) => (
        <FieldRow
          key={`${record.id}:${field.id}`}
          field={field}
          value={record.fields[field.id]}
          canEdit={canEdit && rights.canEditField(field)}
          error={errors.get(field.id)}
          onSave={(v, typecast) => save(field, v, typecast)}
          onError={(e) => setError(field.id, e)}
          onEditing={(on) => setEditing(on ? field.id : null)}
          autoFocus={field.id === focusFieldId}
          recordId={record.id}
          canRegenerate={canEdit}
        />
      ))}
    </dl>
  );
}

/**
 * A record's fields with their editors, outside the expand view: an interface page's field
 * elements. The table's and fields' edit permissions apply as in the expand view.
 */
export function RecordFields({
  table,
  fields,
  record,
  canEdit,
  userRole,
}: {
  table: TableMeta;
  fields: FieldMeta[];
  record: RecordData;
  canEdit: boolean;
  userRole: UserRole | undefined;
}) {
  return (
    <FieldList
      table={table}
      fields={fields}
      hidden={[]}
      recordId={record.id}
      cached={record}
      index={null}
      total={0}
      canEdit={canEdit}
      userRole={userRole}
      layout="modal"
      onLayoutChange={() => {}}
      onNavigate={() => {}}
      onClose={() => {}}
      onDelete={() => {}}
      record={record}
      setEditing={() => {}}
    />
  );
}

/** Moves focus to the field box before or after `from` (Tab and Shift+Tab out of an editor). */
function focusSibling(from: HTMLElement | null, step: 1 | -1) {
  const boxes = Array.from(
    from?.closest('[data-testid="record-expand"]')?.querySelectorAll<HTMLElement>('[data-field]') ??
      []
  );
  const at = from ? boxes.indexOf(from) : -1;
  boxes[at + step]?.focus();
}

function FieldRow({
  field,
  value,
  canEdit,
  error,
  onSave,
  onError,
  onEditing,
  autoFocus,
  recordId,
  canRegenerate = false,
}: {
  field: FieldMeta;
  value: unknown;
  canEdit: boolean;
  error: string | undefined;
  onSave: (value: unknown, typecast?: boolean) => void;
  onError: (error: string | null) => void;
  onEditing: (editing: boolean) => void;
  /** Open this field's editor (or focus it) on mount. */
  autoFocus?: boolean;
  /** The record, for an AI field's state and "Regenerate". */
  recordId?: string;
  canRegenerate?: boolean;
}) {
  const kind = editorKind(field);
  const editable = canEdit && kind !== 'none';
  const inPlace = kind === 'checkbox' || kind === 'rating';
  const ratingMax = (fieldDef(field).options as { max?: number }).max ?? 5;
  const [editing, setEditing] = useState<{ initialText?: string } | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const Icon = FIELD_TYPE_ICONS[field.type];
  const labelId = `record-field-${field.id}`;
  const richText =
    kind === 'longText' && (fieldDef(field).options as { richText?: boolean }).richText === true;

  const open = (initialText?: string) => {
    if (!editable || inPlace || !opensEditor(kind)) return;
    setEditing({ initialText });
    onEditing(true);
  };
  const close = (move: EditorMove) => {
    setEditing(null);
    onEditing(false);
    // Focus after the editor unmounts.
    requestAnimationFrame(() => {
      const box = row.current?.querySelector<HTMLElement>('[data-field]') ?? null;
      if (move === 'stay') box?.focus();
      else if (move === 'next' || move === 'prev') focusSibling(box, move === 'next' ? 1 : -1);
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the view opens
  useEffect(() => {
    if (!autoFocus) return;
    const box = row.current?.querySelector<HTMLElement>('[data-field]');
    box?.scrollIntoView({ block: 'nearest' });
    if (editable && !inPlace && opensEditor(kind)) open();
    else box?.focus();
  }, []);
  const commit = (result: EditorResult, move: EditorMove) => {
    if ('error' in result) {
      onError(result.error);
      toast.error(result.error);
    } else onSave(result.value, result.typecast);
    close(move);
  };

  return (
    <div
      ref={row}
      className="grid grid-cols-[minmax(120px,200px)_1fr] items-start gap-4 py-2 max-sm:grid-cols-1 max-sm:gap-0"
    >
      <dt
        id={labelId}
        className="flex h-[34px] min-w-0 items-center gap-2 text-text-2 max-sm:h-7 max-sm:px-2"
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="truncate" title={field.description ?? field.name}>
          {field.name}
        </span>
      </dt>
      <dd className="min-w-0">
        {editable && kind === 'checkbox' ? (
          // biome-ignore lint/a11y/useSemanticElements: styled like the grid's checkbox
          <button
            type="button"
            role="checkbox"
            aria-checked={value === true}
            aria-labelledby={labelId}
            data-field={field.id}
            onClick={() => onSave(value !== true)}
            className="flex h-[34px] items-center rounded-sm px-2 outline-none focus-visible:outline-2 focus-visible:outline-brand pointer-coarse:h-[44px]"
          >
            <CellContent field={field} value={value} />
          </button>
        ) : editable && kind === 'rating' ? (
          <div
            role="slider"
            tabIndex={0}
            aria-labelledby={labelId}
            aria-valuemin={0}
            aria-valuemax={ratingMax}
            aria-valuenow={typeof value === 'number' ? value : 0}
            data-field={field.id}
            onKeyDown={(e) => {
              const current = typeof value === 'number' ? value : 0;
              let n: number | null = null;
              if (/^\d$/.test(e.key)) n = Number(e.key);
              else if (e.key === 'ArrowRight') n = Math.min(ratingMax, current + 1);
              else if (e.key === 'ArrowLeft') n = Math.max(0, current - 1);
              if (n === null || n > ratingMax) return;
              e.preventDefault();
              e.stopPropagation();
              onSave(n === 0 ? null : n);
            }}
            className="group flex h-[34px] items-center rounded-sm px-2 outline-none focus-visible:outline-2 focus-visible:outline-brand"
          >
            <CellContent field={field} value={value} onChange={onSave} />
          </div>
        ) : !editable ? (
          <div
            data-field={field.id}
            className={cn(
              'flex min-h-[34px] min-w-0 items-center px-2 text-text-2',
              kind === 'longText' && 'items-start py-1.5'
            )}
          >
            {field.type === 'ai' && recordId ? (
              <AiRecordValue
                field={field}
                value={value}
                recordId={recordId}
                canRegenerate={canRegenerate}
              />
            ) : kind === 'longText' ? (
              <LongText field={field} value={value} links />
            ) : fieldDef(field).def.editor.kind === 'link' ? (
              <LinkedRecords field={field} value={value} />
            ) : (
              <CellContent field={field} value={value} button={buttonTarget(field, recordId)} />
            )}
          </div>
        ) : richText && !editing ? (
          // Rich text holds clickable links, which a button can't: a group that opens the
          // editor on Enter, F2 or a click anywhere but a link.
          // biome-ignore lint/a11y/useSemanticElements: a focusable box like every field box, not a form part
          <div
            data-field={field.id}
            role="group"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable like every field box
            tabIndex={0}
            aria-labelledby={labelId}
            aria-description="Press Enter to edit"
            onClick={(e) => {
              if (!(e.target as Element).closest('a')) open();
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === 'F2') {
                e.preventDefault();
                open();
              } else if (e.key === 'Backspace' || e.key === 'Delete') {
                e.preventDefault();
                onSave(null);
              }
            }}
            className={cn(
              'relative flex min-h-[34px] min-w-0 cursor-text items-start rounded-sm border border-border px-2 py-1.5 outline-none hover:border-border-strong focus-visible:border-brand pointer-coarse:min-h-[44px]',
              error && 'border-danger'
            )}
          >
            <LongText field={field} value={value} links />
          </div>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: a box that holds the value and its editor
          <div
            data-field={field.id}
            data-editing={editing ? true : undefined}
            role="button"
            tabIndex={0}
            aria-labelledby={labelId}
            aria-invalid={error ? true : undefined}
            onClick={() => {
              if (!editing) open();
            }}
            onKeyDown={(e) => {
              if (editing || e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === 'F2') {
                e.preventDefault();
                open();
              } else if (e.key === 'Backspace' || e.key === 'Delete') {
                e.preventDefault();
                onSave(null);
              }
            }}
            className={cn(
              'relative flex min-h-[34px] min-w-0 cursor-text items-center rounded-sm border border-border px-2 outline-none hover:border-border-strong focus-visible:border-brand pointer-coarse:min-h-[44px]',
              error && 'border-danger',
              kind === 'longText' && 'items-start py-1.5'
            )}
          >
            {editing ? (
              <CellEditor
                field={field}
                value={value}
                initialText={editing.initialText}
                align="left"
                onCommit={commit}
                onCancel={() => close('stay')}
              />
            ) : kind === 'longText' ? (
              <LongText field={field} value={value} />
            ) : kind === 'link' ? (
              <LinkedRecords field={field} value={value} />
            ) : (
              <CellContent field={field} value={value} />
            )}
          </div>
        )}
        {error && (
          <p className="mt-1 flex items-center gap-1 text-small text-danger">
            <CircleAlert className="size-3.5" aria-hidden />
            Couldn't save: {error}
          </p>
        )}
      </dd>
    </div>
  );
}

/** Long text in full, line breaks kept (the grid cell shows one line); rich text rendered. */
function LongText({
  field,
  value,
  links = false,
}: {
  field: FieldMeta;
  value: unknown;
  links?: boolean;
}) {
  const text = cellText(field, value);
  if ((fieldDef(field).options as { richText?: boolean }).richText === true && text) {
    return <RichText text={text} links={links} className="min-w-0 break-words" />;
  }
  return <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>;
}

/**
 * A link field's records (mockup b-record-modal): chips that open the linked record in its
 * table (its first view, `?record=<id>`), wrapping rather than cut off.
 */
function LinkedRecords({ field, value }: { field: FieldMeta; value: unknown }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const items = linkItems(value);
  const { linkedTableId } = fieldDef(field).options as LinkOptions;
  if (items.length === 0) return null;
  const open = async (recordId: string) => {
    if (!linkedTableId) return;
    try {
      const { views } = await qc.ensureQueryData(viewQueries.list(linkedTableId));
      const view = views[0];
      const table = await qc.ensureQueryData(tableQueries.detail(linkedTableId));
      if (!view) return;
      await navigate({
        to: '/b/$baseId/$tableId/$viewId',
        params: { baseId: table.baseId, tableId: linkedTableId, viewId: view.id },
        search: { record: recordId },
      });
    } catch {
      toast.error("Couldn't open the linked record");
    }
  };
  return (
    <span className="flex min-w-0 flex-wrap gap-1 py-1">
      {items.map((item) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: keeps the click on the chip
        <span
          key={item.id}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <LinkChip
            name={item.name}
            onOpen={item.id.startsWith('pending-') ? undefined : () => void open(item.id)}
          />
        </span>
      ))}
    </span>
  );
}
