import type { FieldMeta, SavedViewQuery } from '@openrows/shared';
import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { FIELD_TYPE_ICONS } from '../../fields/icons';
import { FilterMenu } from './FilterMenu';
import type { ToolbarQuery } from './model';
import { SortMenu } from './SortMenu';
import { FIND_BOX_CLASS, TOOLBAR_CLASS } from './ToolbarLabel';

/**
 * The toolbar of the gallery, timeline and list views: the view's own layout controls
 * (`children`), then the grid's filter and sort menus, find in view and the record count.
 */
export function LayoutToolbar({
  children,
  fields,
  query,
  onQueryChange,
  search,
  onSearchChange,
  count,
  sortable = true,
}: {
  children: ReactNode;
  fields: FieldMeta[];
  query: ToolbarQuery;
  onQueryChange: (patch: SavedViewQuery) => void;
  search: string;
  onSearchChange: (search: string) => void;
  count: string;
  sortable?: boolean;
}) {
  return (
    <div role="toolbar" aria-label="View" className={TOOLBAR_CLASS}>
      {children}
      <FilterMenu
        fields={fields}
        filter={query.filter}
        onChange={(filter) => onQueryChange({ filter })}
      />
      {sortable && (
        <SortMenu
          fields={fields}
          sorts={query.sorts}
          onChange={(sorts) => onQueryChange({ sorts })}
        />
      )}
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <div className={cn(FIND_BOX_CLASS, 'w-56')}>
          <Search className="size-4 shrink-0 text-text-3" aria-hidden />
          <input
            type="search"
            aria-label="Find in view"
            placeholder="Find in view"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onSearchChange('');
            }}
            className="min-w-0 flex-1 bg-transparent text-body outline-none focus-visible:shadow-none placeholder:text-text-3 [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <p className="tnum whitespace-nowrap text-text-2" data-testid="record-count">
          {count}
        </p>
      </div>
    </div>
  );
}

/** Checkboxes for the fields a card or row shows, in table order (the primary field is the title). */
export function FieldPicker({
  label,
  fields,
  shown,
  onChange,
}: {
  label: string;
  fields: FieldMeta[];
  shown: FieldMeta[];
  onChange: (ids: string[]) => void;
}) {
  const others = fields.filter((f) => !f.isPrimary);
  const ids = new Set(shown.map((f) => f.id));
  const toggle = (id: string) =>
    onChange(
      ids.has(id)
        ? shown.map((f) => f.id).filter((x) => x !== id)
        : others.filter((f) => ids.has(f.id) || f.id === id).map((f) => f.id)
    );
  return (
    <>
      <p className="mb-1 text-small text-text-2">{label}</p>
      <ul className="grid max-h-72 gap-0.5 overflow-y-auto" aria-label={label}>
        {others.map((f) => {
          const Icon = FIELD_TYPE_ICONS[f.type];
          return (
            <li key={f.id} className="rounded-sm px-1 hover:bg-hover">
              <label className="flex h-8 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={ids.has(f.id)}
                  aria-label={`Show ${f.name}`}
                  onChange={() => toggle(f.id)}
                  className="size-4 accent-[var(--accent)]"
                />
                {Icon && <Icon className="size-4 shrink-0 text-text-2" aria-hidden />}
                <span className="truncate">{f.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** A labelled `<select>` of fields for a layout key ("None" clears it). */
export function FieldSelect({
  label,
  value,
  fields,
  onChange,
  none = 'None',
}: {
  label: string;
  value: string | null | undefined;
  fields: FieldMeta[];
  onChange: (id: string | null) => void;
  none?: string | false;
}) {
  return (
    <label className="mb-2 flex flex-col gap-1 text-small text-text-2">
      {label}
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-8 rounded-sm border border-border bg-surface px-2 text-body text-text"
      >
        {none !== false && <option value="">{none}</option>}
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </label>
  );
}
