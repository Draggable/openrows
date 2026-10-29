import type { PresencePeer, RealtimeServerMessage } from '@openrows/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '../../components/ui';
import { RealtimeConnection } from './connection';
import {
  PeerCellMarker,
  PresenceAvatars,
  PresenceProvider,
  RecordViewers,
  usePeerCellDescriptions,
  usePresence,
} from './Presence';
import type { CellPresence } from './presence-model';
import { RealtimeProvider, useRealtimeSubscription } from './RealtimeProvider';

const VIEW = '0190a000-0000-7000-8000-0000000000a1';
const REC = '0190a000-0000-7000-8000-0000000000a2';
const BASE = '0190a000-0000-7000-8000-0000000000a4';
const TABLE = '0190a000-0000-7000-8000-0000000000a5';

class FakeSocket {
  sent: unknown[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}

const peer = (n: number, state: Partial<PresencePeer['state']> = {}): PresencePeer => ({
  connectionId: `0190a000-0000-7000-8000-00000000010${n}`,
  userId: `0190a000-0000-7000-8000-00000000020${n}`,
  name: `Person ${n}`,
  initials: `P${n}`,
  color: 'green',
  state: { recordId: null, fieldId: null, editing: false, expandedRecordId: null, ...state },
});

function Page() {
  useRealtimeSubscription({ viewId: VIEW });
  return (
    <PresenceProvider viewId={VIEW}>
      <PresenceAvatars />
      <RecordViewers recordId={REC} />
    </PresenceProvider>
  );
}

function setup() {
  const sockets: FakeSocket[] = [];
  const conn = new RealtimeConnection({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    fetchEvents: async (_b, since) => ({ events: [], next: since, hasMore: false }),
    onEvents: () => {},
    onResync: () => {},
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <RealtimeProvider connection={conn}>
          <Page />
        </RealtimeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const receive = (message: RealtimeServerMessage) =>
    act(() =>
      sockets.at(-1)?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }))
    );
  receive({ type: 'ready', userId: '0190a000-0000-7000-8000-0000000000ff' });
  receive({ type: 'subscribed', target: { viewId: VIEW }, baseId: BASE, tableId: TABLE, seq: 1 });
  return { receive };
}

describe('presence UI (#89)', () => {
  it('shows who else is on the view, and who has the record open, until they leave', () => {
    const { receive } = setup();
    expect(screen.queryByTestId('presence')).toBeNull();
    receive({ type: 'presence', viewId: VIEW, peer: peer(1) });
    receive({ type: 'presence', viewId: VIEW, peer: peer(2, { expandedRecordId: REC }) });
    expect(screen.getByRole('list', { name: 'Also viewing: Person 1 and Person 2' })).toBeTruthy();
    expect(within(screen.getByTestId('presence')).getAllByTestId('presence-avatar')).toHaveLength(
      2
    );
    expect(screen.getByRole('list', { name: 'Also here: Person 2' })).toBeTruthy();
    receive({ type: 'presenceLeft', viewId: VIEW, connectionId: peer(2).connectionId });
    expect(within(screen.getByTestId('presence')).getAllByTestId('presence-avatar')).toHaveLength(
      1
    );
    expect(screen.queryByTestId('record-viewers')).toBeNull();
  });

  it('collapses more than four people into +N', () => {
    const { receive } = setup();
    for (const n of [1, 2, 3, 4, 5, 6]) receive({ type: 'presence', viewId: VIEW, peer: peer(n) });
    expect(within(screen.getByTestId('presence')).getAllByTestId('presence-avatar')).toHaveLength(
      4
    );
    expect(screen.getByText('+2')).toBeTruthy();
  });
});

function MarkedCell({ cells }: { cells: ReadonlyMap<string, CellPresence[]> }) {
  const { describedBy, node } = usePeerCellDescriptions(cells);
  return (
    <>
      {node}
      <table>
        <tbody>
          <tr>
            <td aria-describedby={describedBy('r:f')} data-testid="cell">
              Launch plan v2
              <PeerCellMarker here={cells.get('r:f') ?? []} />
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

describe('PeerCellMarker', () => {
  const person = { id: 'u1', name: 'Ada Lovelace', initials: 'AL', color: 'blue' as const };
  const other = { id: 'u2', name: 'Bea Lopes', initials: 'BL', color: 'green' as const };
  it('outlines the cell in the person colour, initials on hover, editing… while editing', () => {
    const { rerender } = render(<PeerCellMarker here={[{ person, editing: false }]} />);
    const marker = screen.getByTestId('peer-cell');
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(marker.style.outline).toContain('var(--chip-blue)');
    const label = screen.getByTestId('peer-cell-label');
    expect(label.dataset['label']).toBe('AL');
    expect(label.className).toContain('after:content-[attr(data-label)]');
    expect(label.className).toContain('group-hover/cell:block');
    rerender(<PeerCellMarker here={[{ person, editing: true }]} />);
    expect(screen.getByTestId('peer-cell-label').dataset['label']).toBe('AL editing…');
    expect(screen.getByTestId('peer-cell').dataset['editing']).toBe('true');
  });

  it('leaves the cell text and accessible name to the value, and describes who is here', () => {
    const cells = new Map([['r:f', [{ person: other, editing: false }]]]);
    render(<MarkedCell cells={cells} />);
    const cell = screen.getByTestId('cell');
    expect(cell.textContent).toBe('Launch plan v2');
    expect(screen.getByRole('cell', { name: 'Launch plan v2' })).toBe(cell);
    const description = document.getElementById(cell.getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe('Bea Lopes is here');
    expect(description?.closest('[hidden]')).toBeTruthy();
    expect(description?.closest('table')).toBeNull();
  });
});

function Reporter({ patch }: { patch: Partial<PresencePeer['state']> }) {
  const { update } = usePresence();
  useEffect(() => update(patch), [update, patch]);
  return null;
}
const expanded = { expandedRecordId: REC };
const selected = { recordId: REC, fieldId: REC };
function Probe() {
  useRealtimeSubscription({ viewId: VIEW });
  return (
    <PresenceProvider viewId={VIEW}>
      <Reporter patch={expanded} />
      <Reporter patch={selected} />
    </PresenceProvider>
  );
}

describe('PresenceProvider', () => {
  it('merges what its children report, from their first effects on', () => {
    const sockets: FakeSocket[] = [];
    const conn = new RealtimeConnection({
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      fetchEvents: async (_b, since) => ({ events: [], next: since, hasMore: false }),
      onEvents: () => {},
      onResync: () => {},
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RealtimeProvider connection={conn}>
          <Probe />
        </RealtimeProvider>
      </QueryClientProvider>
    );
    const socket = sockets.at(-1);
    act(() => {
      socket?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'ready', userId: '0190a000-0000-7000-8000-0000000000ff' }),
        })
      );
      socket?.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'subscribed',
            target: { viewId: VIEW },
            baseId: BASE,
            tableId: TABLE,
            seq: 1,
          }),
        })
      );
    });
    expect(socket?.sent.filter((m) => (m as { type: string }).type === 'presence')).toEqual([
      {
        type: 'presence',
        viewId: VIEW,
        state: { recordId: REC, fieldId: REC, editing: false, expandedRecordId: REC },
      },
    ]);
  });
});
