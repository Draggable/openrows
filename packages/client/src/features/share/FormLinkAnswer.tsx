import type { FieldMeta } from '@openrows/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Plus, Search, XIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { formQueries } from '../../api/queries';
import { Button, Input, Spinner } from '../../components/ui';
import { linkAnswerOf, pickLink } from './form-model';

/**
 * A linked record answer on the public form: the picked records as chips, and a search
 * over the records the form's creator offers (one view of the linked table, by primary field;
 * the server lists nothing else). Paged with "Show more"; one record for single links.
 */
export function FormLinkAnswer({
  id,
  token,
  field,
  value,
  onChange,
}: {
  id: string;
  token: string;
  field: FieldMeta;
  value: unknown;
  onChange: (value: { id: string; name: string }[]) => void;
}) {
  const picked = linkAnswerOf(value);
  const single = (field.options as { prefersSingleRecordLink?: boolean } | null)
    ?.prefersSingleRecordLink;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const listId = useId();
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);
  const query = useInfiniteQuery({
    ...formQueries.linkRecords(token, field.id, search),
    enabled: open,
  });
  const records = query.data?.pages.flatMap((p) => p.records) ?? [];
  const add = (record: { id: string; name: string }) => {
    onChange(pickLink(picked, record, !!single));
    if (single) setOpen(false);
  };
  const addLabel = single && picked.length > 0 ? 'Change record' : 'Add a record';
  return (
    <div className="grid gap-2">
      {picked.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label={`${field.name}: picked records`}>
          {picked.map((r) => (
            <li
              key={r.id}
              className="flex h-7 items-center gap-1 rounded-sm border border-border bg-app pr-0.5 pl-2 text-small"
            >
              <span className="max-w-60 truncate">{r.name || 'Unnamed record'}</span>
              <button
                type="button"
                aria-label={`Remove ${r.name || 'Unnamed record'}`}
                className="rounded-xs p-0.5 text-text-2 hover:bg-hover"
                onClick={() => onChange(picked.filter((x) => x.id !== r.id))}
              >
                <XIcon aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <Button
          id={id}
          type="button"
          variant="secondary"
          className="w-fit"
          aria-label={addLabel}
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <Plus aria-hidden />
          {addLabel}
        </Button>
      ) : (
        <div className="grid gap-1.5 rounded-sm border border-border p-2">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-2"
            />
            <Input
              id={id}
              type="search"
              autoFocus
              value={text}
              placeholder="Find a record…"
              aria-controls={listId}
              className="pl-7"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
            />
          </div>
          <ul
            id={listId}
            aria-label={`Records for ${field.name}`}
            className="grid max-h-64 overflow-auto"
          >
            {records.map((r) => {
              const on = picked.some((x) => x.id === r.id);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    disabled={on}
                    onClick={() => add(r)}
                    className="flex h-8 w-full items-center rounded-sm px-2 text-left hover:bg-hover disabled:text-text-2"
                  >
                    <span className="truncate">{r.name || 'Unnamed record'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {query.isFetching && <Spinner size="sm" />}
          {!query.isFetching && records.length === 0 && (
            <p className="px-2 text-small text-text-2">
              {query.isError ? 'The records couldn’t be loaded.' : 'No matching records.'}
            </p>
          )}
          <div className="flex gap-2">
            {query.hasNextPage && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                Show more
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
