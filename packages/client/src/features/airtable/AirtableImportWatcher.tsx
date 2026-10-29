import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useWatchedAirtableImports } from '../../api/queries';
import { toast } from '../../components/ui';
import { plural, setWatchedImports, type Watched, watchedImports } from './model';

/** Fired by the import dialog when it starts imports, so the watcher picks them up. */
export const WATCH_EVENT = 'openrows:airtable-watch';

export function watchImports(list: Watched[]) {
  const store = typeof localStorage === 'undefined' ? undefined : localStorage;
  setWatchedImports(store, [...watchedImports(store), ...list]);
  window.dispatchEvent(new Event(WATCH_EVENT));
}

/**
 * The "import done" notification: the Airtable imports started in this browser are
 * polled (only while there are some) and a toast says when each ends, with a link to its base,
 * wherever you are in the app.
 */
export function AirtableImportWatcher() {
  const store = typeof localStorage === 'undefined' ? undefined : localStorage;
  const [watched, setWatched] = useState<Watched[]>(() => watchedImports(store));
  const navigate = useNavigate();
  const { data } = useWatchedAirtableImports(watched);

  useEffect(() => {
    const reload = () => setWatched(watchedImports(store));
    window.addEventListener(WATCH_EVENT, reload);
    return () => window.removeEventListener(WATCH_EVENT, reload);
  }, [store]);

  useEffect(() => {
    if (!data) return;
    const ended = new Set<string>();
    data.forEach((item, i) => {
      const w = watched[i];
      if (!w) return;
      // Gone (another account, expired): stop watching it.
      if (!item) {
        ended.add(w.id);
        return;
      }
      if (item.status === 'running') return;
      ended.add(w.id);
      const open = {
        label: 'Open base',
        onClick: () => navigate({ to: '/b/$baseId', params: { baseId: item.baseId } }),
      };
      if (item.status === 'done') {
        toast.success(`Airtable import done: ${item.name}`, {
          description: `${plural(item.tables, 'table')}, ${plural(item.records, 'record')}`,
          action: open,
        });
      } else if (item.status === 'failed') {
        toast.error(`Airtable import failed: ${item.name}`, {
          description: item.error ?? undefined,
        });
      }
    });
    if (!ended.size) return;
    const next = watchedImports(store).filter((w) => !ended.has(w.id));
    setWatchedImports(store, next);
    setWatched(next);
  }, [data, watched, navigate, store]);

  return null;
}
