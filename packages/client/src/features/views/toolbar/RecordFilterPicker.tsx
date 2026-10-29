import { type FieldMeta, MAX_FILTER_RECORDS } from '@openrows/shared';
import { Check, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFilterCandidates, useLinkedNames } from '../../../api/queries';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../../../components/ui';
import { cn } from '../../../lib/utils';
import { LinkChip } from '../../grid/cells';

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The value of a link filter's `has any of` / `has none of`: the picked records as chips
 * (× removes), and a record picker searching the linked table by primary field, 50 records a
 * page (every record of the linked table the user can read, not only a "limit to a view" one).
 * The value is the records' ids; their names come from the server, so a record deleted since
 * shows as such and still counts as picked until removed.
 */
export function RecordFilterPicker({
  field,
  value,
  onChange,
}: {
  field: FieldMeta;
  value: unknown;
  onChange: (value: string[] | undefined) => void;
}) {
  const picked = Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string')
    : [];
  // Names of records picked here, before the server names them.
  const [known, setKnown] = useState<Record<string, string>>({});
  const named = useLinkedNames(field.id, picked);
  const names = new Map(Object.entries(known));
  for (const r of named.data?.records ?? []) names.set(r.id, r.name);
  const nameOf = (id: string) => {
    const name = names.get(id);
    if (name !== undefined) return name || 'Unnamed record';
    return named.data && !named.isFetching ? 'Deleted record' : '…';
  };
  const set = (ids: string[]) => onChange(ids.length > 0 ? ids : undefined);
  const toggle = (record: { id: string; name: string }) => {
    setKnown((k) => ({ ...k, [record.id]: record.name }));
    if (picked.includes(record.id)) set(picked.filter((id) => id !== record.id));
    else if (picked.length < MAX_FILTER_RECORDS) set([...picked, record.id]);
  };
  return (
    <fieldset
      aria-label={`Value of ${field.name}`}
      className="flex min-h-7 flex-wrap items-center gap-1"
    >
      {picked.map((id) => (
        <LinkChip key={id} name={nameOf(id)}>
          <button
            type="button"
            aria-label={`Remove ${nameOf(id)}`}
            onClick={() => set(picked.filter((x) => x !== id))}
            className="-mr-0.5 rounded-xs text-text-2 hover:text-text"
          >
            <X className="size-3" aria-hidden />
          </button>
        </LinkChip>
      ))}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" disabled={picked.length >= MAX_FILTER_RECORDS}>
            <Plus aria-hidden /> Pick records
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72" aria-label={`Pick ${field.name} records`}>
          <CandidateList field={field} picked={picked} onToggle={toggle} />
        </PopoverContent>
      </Popover>
    </fieldset>
  );
}

function CandidateList({
  field,
  picked,
  onToggle,
}: {
  field: FieldMeta;
  picked: readonly string[];
  onToggle: (record: { id: string; name: string }) => void;
}) {
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const search = useDebounced(query.trim(), 150);
  const { data, isFetching, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useFilterCandidates(field.id, search);
  const candidates = data?.pages.flatMap((p) => p.records) ?? [];
  const active = Math.min(hi, candidates.length - 1);
  const listId = `filter-records-${field.id}`;
  const optionId = (id: string) => `${listId}-${id}`;
  return (
    <div className="grid gap-1">
      <input
        // biome-ignore lint/a11y/noAutofocus: the picker opens for typing
        autoFocus
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={candidates[active] ? optionId(candidates[active].id) : undefined}
        aria-label={`Find a record for ${field.name}`}
        placeholder="Find a record"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi(Math.min(active + 1, candidates.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi(Math.max(active - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const candidate = candidates[active];
            if (candidate) onToggle(candidate);
          }
        }}
        className="h-8 w-full rounded-sm border border-border bg-surface px-2 outline-none focus:border-brand"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={`Records for ${field.name}`}
        aria-multiselectable
        aria-busy={isFetching || undefined}
        className="max-h-60 overflow-y-auto"
      >
        {candidates.map((c, i) => {
          const selected = picked.includes(c.id);
          return (
            <div
              key={c.id}
              id={optionId(c.id)}
              role="option"
              aria-selected={selected}
              tabIndex={-1}
              onMouseEnter={() => setHi(i)}
              onClick={() => onToggle(c)}
              onKeyDown={() => {}}
              className={cn(
                'flex h-8 cursor-default items-center justify-between gap-2 rounded-sm px-1.5',
                i === active && 'bg-hover'
              )}
            >
              <span className={cn('truncate', !c.name && 'text-text-2')}>
                {c.name || 'Unnamed record'}
              </span>
              {selected && <Check aria-hidden className="size-4 shrink-0 text-primary" />}
            </div>
          );
        })}
        {candidates.length === 0 && (
          <p className="px-1.5 py-2 text-small text-text-2">
            {isError ? "Records couldn't be loaded" : data ? 'No matching record' : 'Loading…'}
          </p>
        )}
      </div>
      {hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
