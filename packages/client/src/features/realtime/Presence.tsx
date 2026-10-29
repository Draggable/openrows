import { EMPTY_PRESENCE, type PresencePeer, type PresenceState } from '@openrows/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Tooltip } from '../../components/ui';
import { cn } from '../../lib/utils';
import { useDirectory } from '../collaborators/context';
import { Avatar } from '../collaborators/UserChip';
import {
  type CellPresence,
  cellPresence,
  cellPresenceLabel,
  namesLabel,
  type PresencePerson,
  people,
  recordViewers,
} from './presence-model';
import { usePresencePeers, useRealtimeConnection } from './RealtimeProvider';

/**
 * Presence on the open view: `PresenceProvider` (the base page) holds this tab's state
 * for the view, which the grid (selected cell, open editor) and the base page (expanded
 * record) update, and the other people on it. The view's subscription carries it.
 */
interface PresenceContextValue {
  viewId: string | undefined;
  peers: readonly PresencePeer[];
  update: (patch: Partial<PresenceState>) => void;
  /** This tab's own state on the view, for the extension panel's cursor. */
  local: () => PresenceState;
  onLocal: (listener: () => void) => () => void;
}

const PresenceContext = createContext<PresenceContextValue>({
  viewId: undefined,
  peers: [],
  update: () => {},
  local: () => EMPTY_PRESENCE,
  onLocal: () => () => {},
});

export function PresenceProvider({ viewId, children }: { viewId: string; children: ReactNode }) {
  const conn = useRealtimeConnection();
  const peers = usePresencePeers(viewId);
  // Children's effects run before this component's, so the state starts fresh per view here
  // rather than in an effect.
  const state = useRef<{ viewId: string; state: PresenceState }>({
    viewId,
    state: EMPTY_PRESENCE,
  });
  const [listeners] = useState(() => new Set<() => void>());
  useEffect(() => () => conn?.setPresence(viewId, null), [conn, viewId]);
  const update = useCallback(
    (patch: Partial<PresenceState>) => {
      const current = state.current.viewId === viewId ? state.current.state : EMPTY_PRESENCE;
      state.current = { viewId, state: { ...current, ...patch } };
      conn?.setPresence(viewId, state.current.state);
      for (const listener of listeners) listener();
    },
    [conn, viewId, listeners]
  );
  const local = useCallback(
    () => (state.current.viewId === viewId ? state.current.state : EMPTY_PRESENCE),
    [viewId]
  );
  const onLocal = useCallback(
    (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [listeners]
  );
  const value = useMemo(
    () => ({ viewId, peers, update, local, onLocal }),
    [viewId, peers, update, local, onLocal]
  );
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export const usePresence = () => useContext(PresenceContext);

/** The selected cells of the other people on the view, by `recordId:fieldId`. */
export function useCellPresence(): Map<string, CellPresence[]> {
  const { peers } = usePresence();
  const { byId } = useDirectory();
  return useMemo(() => cellPresence(peers, byId), [peers, byId]);
}

const MAX_AVATARS = 4;

function AvatarStack({ list, label }: { list: readonly PresencePerson[]; label: string }) {
  const shown = list.slice(0, MAX_AVATARS);
  const more = list.length - shown.length;
  return (
    <ul aria-label={label} className="flex items-center -space-x-1">
      {shown.map((person) => (
        <li key={person.id} data-testid="presence-avatar" data-user={person.id}>
          <Tooltip content={person.name}>
            <span className="flex rounded-full ring-2 ring-surface">
              <Avatar person={person} className="size-6 text-[11px]" />
              <span className="sr-only">{person.name}</span>
            </span>
          </Tooltip>
        </li>
      ))}
      {more > 0 && (
        <li>
          <Tooltip content={namesLabel(list.slice(MAX_AVATARS))}>
            <span className="flex size-6 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-text-2 ring-2 ring-surface">
              +{more}
            </span>
          </Tooltip>
        </li>
      )}
    </ul>
  );
}

/** The top bar's "also viewing" avatars: the other people on this view. */
export function PresenceAvatars() {
  const { peers } = usePresence();
  const { byId } = useDirectory();
  const list = useMemo(() => people(peers, byId), [peers, byId]);
  if (list.length === 0) return null;
  return (
    <div data-testid="presence" className="flex items-center">
      <AvatarStack list={list} label={`Also viewing: ${namesLabel(list)}`} />
    </div>
  );
}

/** The record expand header's "also here": who else has this record open. */
export function RecordViewers({ recordId }: { recordId: string }) {
  const { peers } = usePresence();
  const { byId } = useDirectory();
  const list = useMemo(() => recordViewers(peers, recordId, byId), [peers, recordId, byId]);
  if (list.length === 0) return null;
  return (
    <div data-testid="record-viewers" className="flex items-center">
      <AvatarStack list={list} label={`Also here: ${namesLabel(list)}`} />
    </div>
  );
}

/**
 * The cells other people have selected, described for assistive technology: one hidden
 * description per marked cell ("Ada Lovelace is here"), outside the grid's rows, which the cell
 * points at with `aria-describedby`. `node` goes next to the grid; `describedBy(key)` is the id.
 */
export function usePeerCellDescriptions(cells: ReadonlyMap<string, readonly CellPresence[]>): {
  describedBy: (key: string) => string | undefined;
  node: ReactNode;
} {
  const prefix = useId();
  return useMemo(() => {
    const ids = new Map<string, string>();
    const items: ReactNode[] = [];
    for (const [key, here] of cells) {
      const id = `${prefix}peer${ids.size}`;
      ids.set(key, id);
      items.push(
        <span key={key} id={id}>
          {cellPresenceLabel(here)}
        </span>
      );
    }
    return {
      describedBy: (key: string) => ids.get(key),
      node: items.length > 0 ? <div hidden>{items}</div> : null,
    };
  }, [cells, prefix]);
}

/**
 * Another person's selection on a grid cell: an outline in their colour, their initials on
 * hover (the cell is a `group/cell`) and "editing…" while their editor is open. Decorative and
 * not part of the cell's text: the label is a pseudo-element (`data-label`), so `textContent`,
 * copy and the accessible name stay the value; `usePeerCellDescriptions` says who is here.
 */
export function PeerCellMarker({ here }: { here: readonly CellPresence[] }) {
  const first = here[0];
  if (!first) return null;
  const editing = here.find((c) => c.editing);
  const color = first.person.color;
  return (
    <span
      aria-hidden
      data-testid="peer-cell"
      data-peer={here.map((c) => c.person.id).join(' ')}
      data-editing={editing ? true : undefined}
      className="pointer-events-none absolute inset-0 z-[1] select-none"
      style={{ outline: `2px solid var(--chip-${color})`, outlineOffset: '-2px' }}
    >
      <span
        data-testid="peer-cell-label"
        data-label={
          editing
            ? `${editing.person.initials} editing…`
            : here.map((c) => c.person.initials).join(' ')
        }
        className={cn(
          'absolute -top-px right-0 rounded-bl-sm px-1 text-[10px] leading-[14px] font-semibold whitespace-nowrap after:content-[attr(data-label)]',
          !editing && 'hidden group-hover/cell:block'
        )}
        style={{
          background: `var(--chip-${(editing ?? first).person.color}-bg)`,
          color: `var(--chip-${(editing ?? first).person.color}-text)`,
        }}
      />
    </span>
  );
}
