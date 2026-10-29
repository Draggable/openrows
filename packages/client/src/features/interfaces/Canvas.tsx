import {
  type FieldMeta,
  INTERFACE_GRID_COLUMNS,
  type InterfaceElement,
  roleAllows,
  type TableMeta,
  type UserRole,
} from '@openrows/shared';
import { ExternalLinkIcon, PlayIcon } from 'lucide-react';
import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { ApiError, api } from '../../api/client';
import { Button, Input, toast } from '../../components/ui';
import { cn } from '../../lib/utils';
import { RichText } from '../grid/cells/RichText';
import { RecordFields } from '../record/RecordExpand';
import { ChartView, type ElementData, NumberView } from './Charts';
import {
  cellsMoved,
  ELEMENT_LABELS,
  type FilterValues,
  moveElement,
  readingOrder,
  resizeElement,
} from './model';

/** Height of one grid row, and the gap between cells (px). */
const ROW = 40;
const GAP = 8;

export interface ElementContext {
  table: TableMeta;
  /** The selected record (record review pages), as the page's query carries it. */
  record: { id: string; fields: Record<string, unknown>; version: number } | undefined;
  userRole: UserRole | undefined;
  filterValues: FilterValues;
  onFilterChange: (elementId: string, value: unknown) => void;
  /** A number's or chart's data, from the page's data route. */
  dataOf?: ((element: InterfaceElement) => ElementData) | undefined;
  /**
   * The page's own field elements (pages read through the interface's routes): drawn
   * from the page's records instead of the base's record editors.
   */
  renderField?:
    | ((element: Extract<InterfaceElement, { type: 'field' }>, field: FieldMeta) => ReactNode)
    | undefined;
  /** Buttons that run automations can't be clicked here (interface-only viewers). */
  noAutomations?: boolean | undefined;
}

const NO_DATA: ElementData = { data: undefined, fields: undefined, loading: true };

export interface DesignerProps {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (element: InterfaceElement) => void;
  onRemove: (id: string) => void;
}

/**
 * The page's elements on a 12-column grid. In the designer (`designer` set) each element is a
 * box to select, drag (or Alt+arrow) to move, drag its corner (or Alt+Shift+arrow) to resize and
 * Delete to remove; its content is inert there, so a button doesn't fire while arranged.
 */
export function Canvas({
  elements,
  context,
  designer,
}: {
  elements: readonly InterfaceElement[];
  context: ElementContext;
  designer?: DesignerProps | undefined;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    id: string;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    dx: number;
    dy: number;
  } | null>(null);

  if (elements.length === 0 && !designer) return null;

  const pitch = () => {
    // The designer's canvas has 8 px of padding on each side.
    const width = (grid.current?.clientWidth ?? 0) - (designer ? 16 : 0);
    return { col: (width + GAP) / INTERFACE_GRID_COLUMNS, row: ROW + GAP };
  };
  const shown = (el: InterfaceElement): InterfaceElement => {
    if (drag?.id !== el.id) return el;
    return drag.mode === 'move'
      ? moveElement(el, drag.dx, drag.dy)
      : resizeElement(el, drag.dx, drag.dy);
  };
  const start = (e: ReactPointerEvent, el: InterfaceElement, mode: 'move' | 'resize') => {
    if (!designer || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    designer.onSelect(el.id);
    setDrag({ id: el.id, mode, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 });
  };
  const move = (e: ReactPointerEvent) => {
    if (!drag) return;
    const p = pitch();
    const dx = cellsMoved(e.clientX - drag.startX, p.col);
    const dy = cellsMoved(e.clientY - drag.startY, p.row);
    if (dx !== drag.dx || dy !== drag.dy) setDrag({ ...drag, dx, dy });
  };
  const end = (el: InterfaceElement) => {
    if (!drag || !designer) return;
    const next = shown(el);
    setDrag(null);
    if (next.x !== el.x || next.y !== el.y || next.w !== el.w || next.h !== el.h) {
      designer.onChange(next);
    }
  };
  const onKey = (e: React.KeyboardEvent, el: InterfaceElement) => {
    if (!designer || e.target !== e.currentTarget) return;
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = arrows[e.key];
    if (step && e.altKey) {
      e.preventDefault();
      designer.onChange(
        e.shiftKey ? resizeElement(el, step[0], step[1]) : moveElement(el, step[0], step[1])
      );
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      designer.onRemove(el.id);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      designer.onSelect(el.id);
    } else if (e.key === 'Escape') {
      designer.onSelect(null);
    }
  };

  return (
    <div
      ref={grid}
      data-testid="interface-canvas"
      className={cn(
        'grid gap-2',
        designer && 'min-h-[120px] rounded-md border border-dashed border-border-strong p-2'
      )}
      style={{
        gridTemplateColumns: `repeat(${INTERFACE_GRID_COLUMNS}, minmax(0, 1fr))`,
        gridAutoRows: `${ROW}px`,
      }}
    >
      {designer && elements.length === 0 && (
        <p className="col-span-full row-span-2 self-center text-center text-text-2">
          Add elements from the panel on the right.
        </p>
      )}
      {readingOrder(elements).map((original) => {
        const el = shown(original);
        const place = {
          gridColumn: `${el.x + 1} / span ${el.w}`,
          gridRow: `${el.y + 1} / span ${el.h}`,
        };
        const content = <ElementView element={el} context={context} />;
        if (!designer) {
          return (
            <div key={el.id} style={place} className="min-w-0 overflow-auto">
              {content}
            </div>
          );
        }
        const selected = designer.selectedId === el.id;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a box that holds the element's (inert) content
          <div
            key={el.id}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={`${ELEMENT_LABELS[el.type]} element`}
            aria-description="Alt+arrows move it, Alt+Shift+arrows resize it, Delete removes it"
            data-element={el.id}
            style={place}
            onPointerDown={(e) => start(e, original, 'move')}
            onPointerMove={move}
            onPointerUp={() => end(original)}
            onPointerCancel={() => setDrag(null)}
            onKeyDown={(e) => onKey(e, original)}
            className={cn(
              'relative min-w-0 cursor-grab touch-none overflow-hidden rounded-sm border bg-surface p-1 outline-none',
              selected ? 'border-primary' : 'border-border hover:border-border-strong',
              'focus-visible:outline-2 focus-visible:outline-brand',
              drag?.id === el.id && 'cursor-grabbing opacity-90'
            )}
          >
            <div inert className="pointer-events-none h-full">
              {content}
            </div>
            <span
              aria-hidden
              data-testid="resize-handle"
              onPointerDown={(e) => start(e, original, 'resize')}
              onPointerMove={move}
              onPointerUp={() => end(original)}
              className="absolute right-0 bottom-0 size-3 cursor-se-resize rounded-tl-sm bg-border-strong"
            />
          </div>
        );
      })}
    </div>
  );
}

const selectClass =
  'h-8 w-full rounded-sm border border-border bg-surface px-2 text-body text-text hover:border-border-strong';

function ElementView({ element, context }: { element: InterfaceElement; context: ElementContext }) {
  const field = (id: string): FieldMeta | undefined =>
    context.table.fields.find((f) => f.id === id);
  switch (element.type) {
    case 'text':
      return element.content.trim() ? (
        <RichText text={element.content} className="min-w-0 break-words" />
      ) : null;
    case 'filter': {
      const f = field(element.fieldId);
      if (!f) return <Missing />;
      return (
        <FilterControl
          id={`filter-${element.id}`}
          field={f}
          label={element.label || f.name}
          value={context.filterValues[element.id]}
          onChange={(v) => context.onFilterChange(element.id, v)}
        />
      );
    }
    case 'button':
      return <ElementButton element={element} context={context} />;
    case 'field': {
      const f = field(element.fieldId);
      if (!f) return <Missing />;
      if (!context.record) return <p className="px-2 text-text-3">{f.name}: no record selected</p>;
      if (context.renderField) return context.renderField(element, f);
      return (
        <RecordFields
          table={context.table}
          fields={[f]}
          record={{
            ...context.record,
            tableId: context.table.id,
            createdAt: '',
            createdBy: null,
            updatedAt: '',
            updatedBy: null,
          }}
          canEdit={
            element.editable && !!context.userRole && roleAllows(context.userRole, 'record:update')
          }
          userRole={context.userRole}
        />
      );
    }
    case 'number':
      return <NumberView element={element} data={context.dataOf?.(element) ?? NO_DATA} />;
    case 'chart':
      return <ChartView element={element} data={context.dataOf?.(element) ?? NO_DATA} />;
  }
}

function Missing() {
  return <p className="px-2 text-text-3">This field was deleted.</p>;
}

function FilterControl({
  id,
  field,
  label,
  value,
  onChange,
}: {
  id: string;
  field: FieldMeta;
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  let control: ReactNode;
  if (field.type === 'singleSelect') {
    const choices = (field.options as { choices?: { id: string; name: string }[] }).choices ?? [];
    control = (
      <select
        id={id}
        className={selectClass}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">Any</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'checkbox') {
    control = (
      <label className="flex h-8 items-center gap-2 text-text">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 accent-[var(--accent)]"
        />
        Checked only
      </label>
    );
  } else {
    control = (
      <Input
        id={id}
        type="search"
        placeholder="Contains…"
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-small text-text-2">
        {label}
      </label>
      {control}
    </div>
  );
}

function ElementButton({
  element,
  context,
}: {
  element: Extract<InterfaceElement, { type: 'button' }>;
  context: ElementContext;
}) {
  const [busy, setBusy] = useState(false);
  const { action } = element;
  if (action.type === 'openUrl') {
    return (
      <Button variant="secondary" asChild>
        <a href={action.url} target="_blank" rel="noopener noreferrer">
          <ExternalLinkIcon />
          {element.label}
        </a>
      </Button>
    );
  }
  const record = context.record;
  if (context.noAutomations) {
    return (
      <Button variant="secondary" disabled title="Not available on shared interfaces yet">
        <PlayIcon />
        {element.label}
      </Button>
    );
  }
  const run = async () => {
    if (!record) return;
    setBusy(true);
    try {
      const { started } = await api.automations.clickButton({
        params: { tableId: context.table.id, recordId: record.id, fieldId: action.fieldId },
      });
      if (started > 0)
        toast.success(started === 1 ? 'Automation started' : `${started} automations started`);
      else toast.message('No automation is turned on for this button');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't run the automation");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" disabled={busy || !record} onClick={run}>
      <PlayIcon />
      {element.label}
    </Button>
  );
}
