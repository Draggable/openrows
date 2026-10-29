import { downloads, MAX_CONNECTOR_HEADER_ROW, type SyncConnectorInfo } from '@openrows/shared';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ApiError, downloadUrl } from '../../api/client';
import { useConnectorItems } from '../../api/queries';
import { Button, Input } from '../../components/ui';
import { cn } from '../../lib/utils';

/** What the picker has chosen: one id (and its name) per level, and the header row. */
export interface ConnectorChoice {
  path: { id: string; name: string }[];
  headerRow: number;
}

/** The connect link: the provider's consent page, then back to this page. */
export function connectUrl(connectorId: string, returnTo: string): string {
  return downloadUrl(downloads.syncConnectorConnect, {
    params: { connectorId },
    query: { returnTo },
  });
}

/**
 * A sync connector's source picker: "Connect <name>" until you have an account there,
 * then its levels one by one (a spreadsheet, searched by name or a pasted link, then one of its
 * sheets) and the row that holds the column names.
 */
export function ConnectorPicker({
  baseId,
  connector,
  value,
  onChange,
}: {
  baseId: string;
  connector: SyncConnectorInfo;
  value: ConnectorChoice;
  onChange: (value: ConnectorChoice) => void;
}) {
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const ids = { search: useId(), header: useId(), list: useId() };
  const done = value.path.length === connector.levels.length;
  const level = Math.min(value.path.length, connector.levels.length - 1);
  const parents = done ? value.path.slice(0, -1) : value.path;
  const items = useConnectorItems(
    baseId,
    connector.id,
    parents.map((p) => p.id),
    level === 0 ? search : '',
    connector.account !== null
  );

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  if (!connector.account) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-sm border border-border p-3">
        <p className="text-body text-text">{connector.description}</p>
        <p className="text-small text-text-2">
          Connect your {connector.name} account to pick what to sync. OpenRows only reads; you can
          disconnect it in Settings → Connected accounts.
        </p>
        <Button asChild variant="secondary">
          <a href={connectUrl(connector.id, `${location.pathname}${location.search}`)}>
            Connect {connector.name}
          </a>
        </Button>
      </div>
    );
  }

  const levelName = connector.levels[level] ?? '';
  const error = items.error instanceof ApiError ? items.error.message : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-small text-text-2">
        Connected as <span className="text-text">{connector.account.label}</span>
      </p>
      <nav aria-label="Picked so far" className="flex flex-wrap items-center gap-1 text-small">
        {parents.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ ...value, path: parents.slice(0, -1) })}
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            Back
          </Button>
        )}
        {parents.map((p) => (
          <span key={p.id} className="flex items-center gap-1 text-text-2">
            <span className="max-w-[200px] truncate text-text">{p.name}</span>
            <ChevronRight className="size-3.5" aria-hidden />
          </span>
        ))}
        <span className="text-text-2">{levelName}</span>
      </nav>
      {level === 0 && (
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-2 left-2 size-4 text-text-3"
            aria-hidden
          />
          <Input
            id={ids.search}
            aria-label={`Find a ${levelName.toLowerCase()} by name or link`}
            className="pl-7"
            value={typed}
            maxLength={2048}
            placeholder="Search by name, or paste a link"
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      )}
      <div
        id={ids.list}
        role="listbox"
        aria-label={`${levelName}s`}
        className="max-h-48 overflow-y-auto rounded-sm border border-border"
      >
        {items.isPending && <p className="px-2 py-1.5 text-small text-text-2">Loading…</p>}
        {error && (
          <p role="alert" className="px-2 py-1.5 text-small text-danger">
            {error}
          </p>
        )}
        {items.data?.items.length === 0 && (
          <p className="px-2 py-1.5 text-small text-text-2">Nothing found.</p>
        )}
        {items.data?.items.map((item) => {
          const selected = done && value.path.at(-1)?.id === item.id;
          return (
            <div
              key={item.id}
              role="option"
              tabIndex={0}
              aria-selected={selected}
              className={cn(
                'flex h-[34px] cursor-pointer items-center gap-2 px-2 text-body hover:bg-hover focus-visible:bg-hover focus-visible:outline-none',
                selected && 'bg-selected text-text'
              )}
              onClick={() => onChange({ ...value, path: [...parents, item] })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onChange({ ...value, path: [...parents, item] });
                }
              }}
            >
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.detail && (
                <span className="shrink-0 text-small text-text-2">{item.detail}</span>
              )}
              {!item.leaf && <ChevronRight className="size-3.5 text-text-3" aria-hidden />}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={ids.header} className="text-small text-text-2">
          Column names are in row
        </label>
        <Input
          id={ids.header}
          type="number"
          className="w-20"
          min={1}
          max={MAX_CONNECTOR_HEADER_ROW}
          value={value.headerRow}
          onChange={(e) => {
            const n = Math.trunc(Number(e.target.value));
            if (n >= 1 && n <= MAX_CONNECTOR_HEADER_ROW) onChange({ ...value, headerRow: n });
          }}
        />
      </div>
    </div>
  );
}
