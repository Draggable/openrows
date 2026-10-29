import type { FieldMeta, RowColor, RowHeight, SavedViewQuery } from '@openrows/shared';
import { ChevronDown, ChevronUp, Download, Ellipsis, FileUp, Rows3, Search, X } from 'lucide-react';
import type { RefObject } from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { RowColorMenu } from '../rowColor/RowColorMenu';
import { FilterMenu } from './FilterMenu';
import { HideFieldsMenu } from './HideFieldsMenu';
import type { ToolbarQuery } from './model';
import { GroupMenu, SortMenu } from './SortMenu';
import { FIND_BOX_CLASS, TOOLBAR_CLASS, ToolbarLabel } from './ToolbarLabel';

const ROW_HEIGHT_LABELS: Record<RowHeight, string> = {
  compact: 'Short',
  default: 'Medium',
  medium: 'Tall',
  tall: 'Extra tall',
};

export type FindState = {
  term: string;
  setTerm: (term: string) => void;
  next: () => void;
  previous: () => void;
  /** "3 of 12", or `null` before a search. */
  position: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Back to the grid (Esc). */
  close: () => void;
};

/**
 * The view toolbar (mockup a-grid): hide fields, filter, group, sort, row height, color, CSV
 * import and download, find in view (Ctrl/Cmd+F) and the record count. Filter, sort and group run on the server (the grid
 * sends them with its view query); the controls save them to the view when the role may.
 */
export function ViewToolbar({
  fields,
  hidden,
  onHiddenChange,
  onOrderChange,
  query,
  onQueryChange,
  rowHeight,
  onRowHeightChange,
  rowColor,
  onRowColorChange,
  find,
  count,
  exportHref,
  onImport,
}: {
  fields: FieldMeta[];
  hidden: string[];
  onHiddenChange: (hidden: string[]) => void;
  onOrderChange: (order: string[]) => void;
  query: ToolbarQuery;
  onQueryChange: (patch: SavedViewQuery) => void;
  rowHeight: RowHeight;
  onRowHeightChange: (h: RowHeight) => void;
  rowColor: RowColor | null;
  onRowColorChange: (rowColor: RowColor | null) => void;
  find: FindState;
  count: string;
  /** The CSV download of the view as shown. */
  exportHref: string;
  /** Opens the CSV import; omitted when the role can't add records. */
  onImport?: (() => void) | undefined;
}) {
  return (
    <div role="toolbar" aria-label="View" className={TOOLBAR_CLASS}>
      <HideFieldsMenu
        fields={fields}
        hidden={hidden}
        onHiddenChange={onHiddenChange}
        onOrderChange={onOrderChange}
      />
      <FilterMenu
        fields={fields}
        filter={query.filter}
        onChange={(filter) => onQueryChange({ filter })}
      />
      <GroupMenu
        fields={fields}
        groupBy={query.groupBy}
        onChange={(groupBy) => onQueryChange({ groupBy })}
      />
      <SortMenu
        fields={fields}
        sorts={query.sorts}
        onChange={(sorts) => onQueryChange({ sorts })}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" title="Row height">
            <Rows3 className="size-4 text-text-2" aria-hidden />
            <ToolbarLabel label="Row height" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {(Object.keys(ROW_HEIGHT_LABELS) as RowHeight[]).map((h) => (
            <DropdownMenuItem
              key={h}
              onSelect={() => onRowHeightChange(h)}
              className={cn(rowHeight === h && 'bg-selected')}
            >
              {ROW_HEIGHT_LABELS[h]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <RowColorMenu fields={fields} rowColor={rowColor} onChange={onRowColorChange} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="More view actions">
            <Ellipsis className="size-4 text-text-2" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {onImport && (
            <DropdownMenuItem onSelect={onImport}>
              <FileUp className="size-4 text-text-2" aria-hidden />
              Import CSV…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild>
            <a href={exportHref} download>
              <Download className="size-4 text-text-2" aria-hidden />
              Download CSV
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <FindInput find={find} />
        <p className="tnum whitespace-nowrap text-text-2" data-testid="record-count">
          {count}
        </p>
      </div>
    </div>
  );
}

function FindInput({ find }: { find: FindState }) {
  return (
    <div className={cn(FIND_BOX_CLASS, 'w-64 max-md:w-44 pointer-coarse:h-[40px]')}>
      <Search className="size-4 shrink-0 text-text-3" aria-hidden />
      <input
        ref={find.inputRef}
        type="search"
        aria-label="Find in view"
        aria-keyshortcuts="Control+F Meta+F"
        placeholder="Find in view"
        value={find.term}
        onChange={(e) => find.setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) find.previous();
            else find.next();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            find.close();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-body outline-none focus-visible:shadow-none placeholder:text-text-3 [&::-webkit-search-cancel-button]:hidden"
      />
      {find.term && (
        <>
          <span className="tnum shrink-0 text-small text-text-2" data-testid="find-position">
            {find.position}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            onClick={find.previous}
            className="rounded-xs text-text-2 hover:text-text"
          >
            <ChevronUp className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next match"
            onClick={find.next}
            className="rounded-xs text-text-2 hover:text-text"
          >
            <ChevronDown className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Clear find"
            onClick={find.close}
            className="rounded-xs text-text-2 hover:text-text"
          >
            <X className="size-4" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
