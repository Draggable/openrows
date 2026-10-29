import type { FieldMeta, KanbanLayout, SavedViewQuery } from '@openrows/shared';
import { ChevronDown, Columns3, LayoutList, Search } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { FIELD_TYPE_ICONS } from '../../fields/icons';
import { FilterMenu } from '../toolbar/FilterMenu';
import type { ToolbarQuery } from '../toolbar/model';
import { SortMenu } from '../toolbar/SortMenu';
import { TOOLBAR_CLASS, ToolbarLabel } from '../toolbar/ToolbarLabel';
import { stackableFields } from './model';

/**
 * The kanban toolbar (mockup c-kanban): the stack field, the card's fields and cover,
 * collapsing empty stacks, filter, sort, find and the record count. Filter and sort are the
 * grid's menus; a sort replaces the manual card order, as in Airtable.
 */
export function KanbanToolbar({
  fields,
  layout,
  stackField,
  cardFields,
  onLayoutChange,
  query,
  onQueryChange,
  search,
  onSearchChange,
  count,
}: {
  fields: FieldMeta[];
  layout: KanbanLayout;
  stackField: FieldMeta | undefined;
  cardFields: FieldMeta[];
  onLayoutChange: (patch: KanbanLayout) => void;
  query: ToolbarQuery;
  onQueryChange: (patch: SavedViewQuery) => void;
  search: string;
  onSearchChange: (search: string) => void;
  count: string;
}) {
  const stackable = stackableFields(fields);
  const others = fields.filter((f) => !f.isPrimary);
  const shown = new Set(cardFields.map((f) => f.id));
  const attachments = fields.filter((f) => f.type === 'attachment');
  const toggle = (id: string) => {
    const ids = cardFields.map((f) => f.id);
    onLayoutChange({
      cardFields: shown.has(id)
        ? ids.filter((x) => x !== id)
        : others.filter((f) => shown.has(f.id) || f.id === id).map((f) => f.id),
    });
  };
  return (
    <div role="toolbar" aria-label="View" className={TOOLBAR_CLASS}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            title={stackField ? `Stacked by: ${stackField.name}` : 'Stack by'}
          >
            <Columns3 className="size-4 text-text-2" aria-hidden />
            <ToolbarLabel label={stackField ? `Stacked by: ${stackField.name}` : 'Stack by'} />
            <ChevronDown className="size-3.5 text-text-3" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {stackable.length === 0 && (
            <DropdownMenuItem disabled>No single select or user fields</DropdownMenuItem>
          )}
          {stackable.map((f) => {
            const Icon = FIELD_TYPE_ICONS[f.type];
            return (
              <DropdownMenuItem
                key={f.id}
                onSelect={() => onLayoutChange({ stackFieldId: f.id })}
                className={cn(f.id === stackField?.id && 'bg-selected')}
              >
                {Icon && <Icon className="size-4 text-text-2" aria-hidden />}
                {f.name}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" title="Customize cards">
            <LayoutList className="size-4 text-text-2" aria-hidden />
            <ToolbarLabel label="Customize cards" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80" aria-label="Customize cards">
          <label className="mb-2 flex flex-col gap-1 text-small text-text-2">
            Cover image
            <select
              value={layout.coverFieldId ?? ''}
              onChange={(e) => onLayoutChange({ coverFieldId: e.target.value || null })}
              className="h-8 rounded-sm border border-border bg-surface px-2 text-body text-text"
            >
              <option value="">None</option>
              {attachments.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-2 flex h-8 cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={layout.collapseEmpty === true}
              onChange={(e) => onLayoutChange({ collapseEmpty: e.target.checked })}
              className="size-4 accent-[var(--accent)]"
            />
            Collapse empty stacks
          </label>
          <p className="mb-1 text-small text-text-2">Fields on cards</p>
          <ul className="grid max-h-72 gap-0.5 overflow-y-auto" aria-label="Fields on cards">
            {others.map((f) => {
              const Icon = FIELD_TYPE_ICONS[f.type];
              return (
                <li key={f.id} className="rounded-sm px-1 hover:bg-hover">
                  <label className="flex h-8 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={shown.has(f.id)}
                      aria-label={`Show ${f.name} on cards`}
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
        </PopoverContent>
      </Popover>
      <FilterMenu
        fields={fields}
        filter={query.filter}
        onChange={(filter) => onQueryChange({ filter })}
      />
      <SortMenu
        fields={fields}
        sorts={query.sorts}
        onChange={(sorts) => onQueryChange({ sorts })}
      />
      <div className="ml-auto flex items-center gap-3">
        <div className="flex h-7 w-64 items-center gap-1 rounded-sm border border-border bg-surface px-2 focus-within:border-brand focus-within:shadow-[0_0_0_1px_var(--brand)]">
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
