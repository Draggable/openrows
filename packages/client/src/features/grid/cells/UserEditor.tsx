import type { UserOptions } from '@openrows/shared';
import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { useDirectory } from '../../collaborators/context';
import { readUserIds } from '../../collaborators/model';
import { Avatar, UserChip } from '../../collaborators/UserChip';
import { type CellEditorProps, type EditorMove, EditorPopover, tabMove, useOnce } from './editors';
import { fieldDef } from './model';

/**
 * The user field's editor: a searchable list of the base's collaborators (the directory
 * ). One person saves on pick; with `multiple`, picks toggle and save when it closes (Esc,
 * Tab, a click outside). Former members already in the cell stay until removed; the server
 * accepts only collaborators otherwise.
 */
export function UserEditor({ field, value, initialText, onCommit, onCancel }: CellEditorProps) {
  const { list } = useDirectory();
  const multiple = (fieldDef(field).options as UserOptions).multiple === true;
  const [picked, setPicked] = useState(() => readUserIds(value));
  const [query, setQuery] = useState(initialText ?? '');
  const [hi, setHi] = useState(0);
  const once = useOnce();
  const q = query.trim().toLowerCase();
  const shown = q
    ? list.filter((c) => c.name.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q))
    : list;
  const active = Math.min(hi, shown.length - 1);
  const save = (ids: string[], move: EditorMove) =>
    once(() => onCommit({ value: ids.length ? ids : null }, move));
  const pick = (id: string) => {
    if (!multiple) return save([id], 'stay');
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    setQuery('');
  };
  const listId = `user-${field.id}`;
  return (
    <EditorPopover
      label={field.name}
      width={300}
      onOutside={() => (multiple ? save(picked, 'away') : once(onCancel))}
      onEscape={() => (multiple ? save(picked, 'stay') : once(onCancel))}
    >
      {multiple && picked.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {picked.map((id) => (
            <span
              key={id}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border pr-1 pl-0.5"
            >
              <UserChip userId={id} />
              <button
                type="button"
                aria-label="Remove person"
                onClick={() => setPicked((p) => p.filter((x) => x !== id))}
                className="rounded-full text-text-2 hover:text-text"
              >
                <X className="size-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        // biome-ignore lint/a11y/noAutofocus: the editor opens on purpose
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={shown[active] ? `${listId}-${shown[active].id}` : undefined}
        aria-label={`Find a collaborator for ${field.name}`}
        placeholder="Find a collaborator"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi(Math.min(active + 1, shown.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi(Math.max(active - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const person = shown[active];
            if (person) pick(person.id);
            else if (multiple) save(picked, 'stay');
          } else if (e.key === 'Tab') {
            e.preventDefault();
            if (multiple) save(picked, tabMove(e));
            else once(() => onCommit({ value: picked.length ? picked : null }, tabMove(e)));
          } else if (e.key === 'Backspace' && multiple && query === '' && picked.length) {
            setPicked((p) => p.slice(0, -1));
          }
        }}
        className="h-8 w-full rounded-sm border border-border bg-surface px-2 outline-none focus:border-brand"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={field.name}
        aria-multiselectable={multiple || undefined}
        className="mt-1 max-h-60 overflow-y-auto"
      >
        {shown.map((c, i) => {
          const selected = picked.includes(c.id);
          return (
            <div
              key={c.id}
              id={`${listId}-${c.id}`}
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(c.id)}
              onKeyDown={() => {}}
              className={cn(
                'flex h-8 cursor-default items-center gap-2 rounded-sm px-1.5',
                i === active && 'bg-hover'
              )}
            >
              <Avatar person={c} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.email && <span className="truncate text-small text-text-2">{c.email}</span>}
              {selected && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
            </div>
          );
        })}
        {shown.length === 0 && (
          <p className="px-1.5 py-2 text-small text-text-2">No matching collaborator</p>
        )}
      </div>
      {!multiple && picked.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full justify-start"
          onClick={() => save([], 'stay')}
        >
          Clear
        </Button>
      )}
    </EditorPopover>
  );
}
