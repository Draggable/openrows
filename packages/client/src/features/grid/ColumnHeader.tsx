import type { FieldMeta } from '@openrows/shared';
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  Copy,
  EyeOff,
  Info,
  Lock,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipProvider,
} from '../../components/ui';
import { cn } from '../../lib/utils';
import { AiFieldMenuItems } from '../ai-fields/AiCell';
import { FIELD_TYPE_ICONS } from '../fields/icons';
import { clampWidth, defaultWidth, type GridColumn } from './layout';

export const DRAG_TYPE = 'application/x-openrows-field';

export type ColumnActions = {
  /** Live width while dragging the edge; `commit` saves it. */
  resize: (fieldId: string, width: number, commit: boolean) => void;
  move: (fieldId: string, toIndex: number) => void;
  freezeThrough: (index: number) => void;
  selectColumn: (index: number) => void;
  /** Field management; `anchor` is the header the editor opens under. */
  editField: (
    field: FieldMeta,
    anchor: HTMLElement,
    focus?: 'name' | 'description' | 'type'
  ) => void;
  insertField: (field: FieldMeta, side: 'left' | 'right', anchor: HTMLElement) => void;
  duplicateField: (field: FieldMeta, anchor: HTMLElement) => void;
  hideField: (fieldId: string) => void;
  deleteField: (field: FieldMeta) => void;
  /** Who may edit the field's cells (creators and up). */
  editPermissions: (field: FieldMeta) => void;
};

/**
 * A field's header cell: the name opens the column menu (edit, rename, change type, describe,
 * duplicate, insert left/right, move, freeze, select, reset width, hide, delete);
 * the right edge resizes by drag or with the arrow keys; dragging the header reorders.
 */
export function ColumnHeader({
  column,
  index,
  frozenThrough,
  canReorder,
  canEditSchema,
  lock,
  actions,
}: {
  column: GridColumn;
  index: number;
  /** Index of the last frozen column. */
  frozenThrough: number;
  canReorder: boolean;
  /** Owners and creators: the field's own settings. */
  canEditSchema: boolean;
  /**
   * The field's edit permission when it's restricted: `editable` is whether the signed-in
   * user may still edit it. Shows the lock.
   */
  lock?: { editable: boolean; synced?: boolean } | undefined;
  actions: ColumnActions;
}) {
  const { field, width } = column;
  const drag = useRef<{ x: number; width: number } | null>(null);
  const movable = canReorder && !field.isPrimary;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLDivElement>(null);
  // An item that opens the field editor or a dialog keeps the focus there, not on the header.
  const keepFocus = useRef(false);
  const anchor = () => {
    keepFocus.current = true;
    return header.current ?? document.body;
  };
  const Icon = FIELD_TYPE_ICONS[field.type];

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    actions.resize(field.id, clampWidth(drag.current.width + e.clientX - drag.current.x), false);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    actions.resize(field.id, clampWidth(drag.current.width + e.clientX - drag.current.x), true);
    drag.current = null;
  };
  const onResizeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      actions.resize(field.id, clampWidth(width + (e.key === 'ArrowLeft' ? -step : step)), true);
    }
  };

  return (
    <div
      ref={header}
      role="columnheader"
      aria-colindex={index + 2}
      aria-label={field.name}
      aria-busy={field.recomputing ?? undefined}
      data-field-id={field.id}
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, field.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={(e) => {
        if (canReorder && e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) actions.move(id, index);
      }}
      className={cn(
        'relative flex h-full shrink-0 items-center border-r border-b border-border bg-header',
        index === frozenThrough && 'border-r-border-strong'
      )}
      style={{ width }}
    >
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        {/* Radix's trigger opens on pointer down and cancels it, which would stop the header
            from being dragged: the menu hangs off an empty trigger, a plain button opens it. */}
        <DropdownMenuTrigger
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0"
        />
        <button
          ref={menuButton}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setMenuOpen(true);
            }
          }}
          className="flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left font-[550] outline-none hover:bg-hover focus-visible:bg-hover"
        >
          <Icon className="size-3.5 shrink-0 text-text-2" aria-hidden />
          <span className="truncate">{field.name}</span>
          {field.recomputing && <RecomputingHint />}
          {lock && <LockHint editable={lock.editable} synced={lock.synced === true} />}
          {field.description && <DescriptionHint description={field.description} />}
          <ChevronDown className="ml-auto size-3.5 shrink-0 text-text-3" aria-hidden />
        </button>
        <DropdownMenuContent
          align="start"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            if (keepFocus.current) keepFocus.current = false;
            else menuButton.current?.focus();
          }}
        >
          {canEditSchema && (
            <>
              <DropdownMenuItem onSelect={() => actions.editField(field, anchor())}>
                <Pencil aria-hidden />
                Edit field
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.editField(field, anchor(), 'name')}>
                Rename field
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.editField(field, anchor(), 'type')}>
                Change field type
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.editField(field, anchor(), 'description')}>
                <Info aria-hidden />
                Edit description
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  keepFocus.current = true;
                  actions.editPermissions(field);
                }}
              >
                <ShieldCheck />
                Edit permissions
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.duplicateField(field, anchor())}>
                <Copy aria-hidden />
                Duplicate field
              </DropdownMenuItem>
              {!field.isPrimary && (
                <DropdownMenuItem onSelect={() => actions.insertField(field, 'left', anchor())}>
                  <ArrowLeftToLine aria-hidden />
                  Insert left
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => actions.insertField(field, 'right', anchor())}>
                <ArrowRightToLine aria-hidden />
                Insert right
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {field.type === 'ai' && <AiFieldMenuItems field={field} />}
            </>
          )}
          {movable && (
            <>
              <DropdownMenuItem onSelect={() => actions.move(field.id, index - 1)}>
                Move left
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => actions.move(field.id, index + 1)}>
                Move right
              </DropdownMenuItem>
            </>
          )}
          {canReorder && index !== frozenThrough && (
            <DropdownMenuItem onSelect={() => actions.freezeThrough(index)}>
              Freeze up to this field
            </DropdownMenuItem>
          )}
          {canReorder && frozenThrough > 0 && (
            <DropdownMenuItem onSelect={() => actions.freezeThrough(0)}>
              Unfreeze columns
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => actions.selectColumn(index)}>
            Select column
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.resize(field.id, defaultWidth(field), true)}>
            Reset width
          </DropdownMenuItem>
          {!field.isPrimary && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => actions.hideField(field.id)}>
                <EyeOff aria-hidden />
                Hide field
              </DropdownMenuItem>
              {canEditSchema && (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    keepFocus.current = true;
                    actions.deleteField(field);
                  }}
                >
                  <Trash2 aria-hidden />
                  Delete field
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${field.name}`}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onResizeKey}
        onDoubleClick={() => actions.resize(field.id, defaultWidth(field), true)}
        className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize outline-none hover:bg-border-strong focus-visible:bg-brand"
      />
    </div>
  );
}

/**
 * The field's description: an info icon in the header with the text in a tooltip on
 * hover. Screen readers get it as the header button's description.
 */
function DescriptionHint({ description }: { description: string }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip content={<span className="block max-w-72 whitespace-pre-wrap">{description}</span>}>
        <span className="flex shrink-0 text-text-3" data-testid="field-description">
          <Info className="size-3.5" aria-hidden />
          <span className="sr-only">{description}</span>
        </span>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The lock of a field with restricted editing, with who can edit in its tooltip. */
/**
 * A computed field the server's worker is recomputing: a large change made more of its
 * values stale than a request recomputes, so they may be out of date until it's done.
 */
function RecomputingHint() {
  const text = 'Updating values. Some may be out of date for a moment.';
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip content={text}>
        <span className="flex shrink-0 text-text-3" data-testid="field-recomputing">
          <RefreshCw className="size-3.5 motion-safe:animate-spin" aria-hidden />
          <span className="sr-only">{text}</span>
        </span>
      </Tooltip>
    </TooltipProvider>
  );
}

function LockHint({ editable, synced }: { editable: boolean; synced: boolean }) {
  // A synced field is read-only: its values come from the sync's source.
  const text = synced
    ? 'Synced from another table: read-only here.'
    : editable
      ? 'Editing this field is restricted. You can edit it.'
      : "You don't have permission to edit this field.";
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip content={text}>
        <span className="flex shrink-0 text-text-3" data-testid="field-lock">
          <Lock className="size-3.5" aria-hidden />
          <span className="sr-only">{text}</span>
        </span>
      </Tooltip>
    </TooltipProvider>
  );
}
