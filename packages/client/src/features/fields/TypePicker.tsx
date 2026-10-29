import { type FieldCategory, type FieldTypeName, getFieldType } from '@openrows/shared';
import { Check, Search } from 'lucide-react';
import { type KeyboardEvent, useId, useState } from 'react';
import { cn } from '../../lib/utils';
import { FIELD_TYPE_ICONS } from './icons';
import { typeGroups } from './model';

const LEFT: ReadonlySet<FieldCategory> = new Set(['basic', 'choice', 'contact']);

/**
 * The field-type picker (DESIGN.md "Field config popover", mockup e): a search box over the
 * registry's types grouped by category in two columns. Arrows move through the matches, Enter
 * picks the active one; clicking picks too.
 */
export function TypePicker({
  value,
  onChange,
  autoFocus,
  exclude,
}: {
  value: FieldTypeName;
  onChange: (type: FieldTypeName) => void;
  autoFocus?: boolean;
  /** Types not offered (AI fields while the workspace has no AI provider). */
  exclude?: readonly FieldTypeName[];
}) {
  const [search, setSearch] = useState('');
  const groups = typeGroups(search, exclude);
  // Two columns as in the mockup: basic, choice and contact left; people and computed right.
  const left = groups.filter((g) => LEFT.has(g.category));
  const right = groups.filter((g) => !LEFT.has(g.category));
  const flat = [...left, ...right].flatMap((g) => g.types);
  const [active, setActive] = useState<FieldTypeName | null>(null);
  const current = active && flat.includes(active) ? active : (flat[0] ?? null);
  const id = useId();
  const optionId = (t: FieldTypeName) => `${id}-${t}`;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = current ? flat.indexOf(current) : -1;
      const next =
        flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) setActive(next);
    } else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (current) onChange(current);
    }
  };

  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-3"
          aria-hidden
        />
        <input
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={search && current ? optionId(current) : undefined}
          aria-label="Search field types"
          placeholder="Search types…"
          // biome-ignore lint/a11y/noAutofocus: the picker opens for typing
          autoFocus={autoFocus}
          data-autofocus={autoFocus ? '' : undefined}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActive(null);
          }}
          onKeyDown={onKeyDown}
          className="flex h-8 w-full rounded-sm border border-border bg-surface pr-2.5 pl-8 text-body text-text placeholder:text-text-3 hover:border-border-strong"
        />
      </div>
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label="Field type"
        className="grid grid-cols-2 gap-x-4"
      >
        {groups.length === 0 && (
          <p className="col-span-2 px-2 py-1 text-text-2">No matching types</p>
        )}
        {[left, right].map((column, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the two fixed columns
          <div key={i} className="grid content-start">
            {column.map((g) => (
              // biome-ignore lint/a11y/useSemanticElements: an ARIA group of listbox options
              <div
                key={g.category}
                role="group"
                aria-label={g.label}
                className="break-inside-avoid pb-2"
              >
                <div className="px-2 pt-1 pb-0.5 text-caps font-semibold tracking-wide text-text-2 uppercase">
                  {g.label}
                </div>
                {g.types.map((t) => {
                  const Icon = FIELD_TYPE_ICONS[t];
                  const selected = t === value;
                  return (
                    <div
                      key={t}
                      id={optionId(t)}
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onChange(t)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onChange(t);
                        }
                      }}
                      className={cn(
                        'flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-text hover:bg-hover',
                        search && t === current && 'bg-hover',
                        selected && 'bg-selected font-[550]'
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-text-2" aria-hidden />
                      <span className="truncate">{getFieldType(t).label}</span>
                      {selected && (
                        <Check className="ml-auto size-4 shrink-0 text-primary" aria-hidden />
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
