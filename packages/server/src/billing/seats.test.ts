import { describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import type { RelayEvent } from '../jobs/relay.js';
import { SEAT_SYNC_DELAY_SECONDS, seatSubscriber, seatTarget } from './seats.js';

const event = (id: number, workspaceId: string, kind: string): RelayEvent => ({
  id,
  txid: '1',
  workspaceId,
  baseId: null,
  tableId: null,
  kind,
  actorId: null,
  createdAt: new Date(),
});

describe('seat sync (#132)', () => {
  it('queues one debounced job per workspace for membership events only', async () => {
    const matches = await seatSubscriber.match(
      [
        event(1, 'w1', 'member.updated'),
        event(2, 'w1', 'baseMember.added'),
        event(3, 'w2', 'record.updated'),
        event(4, 'w2', 'workspace.updated'),
        event(5, 'w3', 'member.removed'),
        event(6, 'w4', 'base.deleted'),
      ],
      {} as Database
    );
    expect(matches.map((m) => [m.event.id, m.singletonKey, m.startAfter])).toEqual([
      [1, 'seats:w1', SEAT_SYNC_DELAY_SECONDS],
      [5, 'seats:w3', SEAT_SYNC_DELAY_SECONDS],
      [6, 'seats:w4', SEAT_SYNC_DELAY_SECONDS],
    ]);
  });

  it('bills at least one seat', () => {
    expect(seatTarget(0)).toBe(1);
    expect(seatTarget(7)).toBe(7);
  });
});
