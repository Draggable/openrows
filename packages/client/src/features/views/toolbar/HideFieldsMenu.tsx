import type { FieldMeta } from '@openrows/shared';
import { ArrowDown, ArrowUp, EyeOff } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { FIELD_TYPE_ICONS } from '../../fields/icons';
import { ToolbarLabel } from './ToolbarLabel';

/**
 * Hide fields: a switch per field (the primary field always shows), show/hide all, and
 * the field order (the buttons, or Alt+↑/↓ on a field). `order` is the view's full field order
 * (hidden fields included); changes go to the grid layout (`hiddenFields`, `fieldOrder`).
 */
export function HideFieldsMenu({
  fields,
  hidden,
  onHiddenChange,
  onOrderChange,
}: {
  /** Every field in the view's order, the primary field first. */
  fields: FieldMeta[];
  hidden: string[];
  onHiddenChange: (hidden: string[]) => void;
  onOrderChange: (order: string[]) => void;
}) {
  const others = fields.filter((f) => !f.isPrimary);
  const move = (id: string, by: number) => {
    const ids = fields.map((f) => f.id);
    const from = ids.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= ids.length || fields[to]?.isPrimary) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    onOrderChange(ids);
  };
  const onKeyDown = (e: KeyboardEvent, id: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    move(id, e.key === 'ArrowUp' ? -1 : 1);
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(hidden.length > 0 && 'bg-selected text-primary')}
          title="Hide fields"
        >
          <EyeOff className="size-4" aria-hidden />
          <ToolbarLabel label="Hide fields" count={hidden.length} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80" aria-label="Hide fields">
        <ul className="grid max-h-80 gap-0.5 overflow-y-auto" aria-label="Fields">
          {others.map((f, i) => {
            const Icon = FIELD_TYPE_ICONS[f.type];
            const shown = !hidden.includes(f.id);
            return (
              <li
                key={f.id}
                className="group flex items-center gap-2 rounded-sm px-1 hover:bg-hover"
              >
                <label className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={shown}
                    aria-label={`Show ${f.name}`}
                    onKeyDown={(e) => onKeyDown(e, f.id)}
                    onChange={() =>
                      onHiddenChange(shown ? [...hidden, f.id] : hidden.filter((h) => h !== f.id))
                    }
                    className="size-4 accent-[var(--accent)]"
                  />
                  {Icon && <Icon className="size-4 shrink-0 text-text-2" aria-hidden />}
                  <span className="truncate">{f.name}</span>
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${f.name} up`}
                  disabled={i === 0}
                  onClick={() => move(f.id, -1)}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <ArrowUp aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${f.name} down`}
                  disabled={i === others.length - 1}
                  onClick={() => move(f.id, 1)}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <ArrowDown aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="mt-2 flex gap-2 border-t border-border pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1"
            onClick={() => onHiddenChange(others.map((f) => f.id))}
          >
            Hide all
          </Button>
          <Button variant="ghost" size="sm" className="flex-1" onClick={() => onHiddenChange([])}>
            Show all
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
