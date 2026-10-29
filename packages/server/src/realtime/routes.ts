import { contracts, type RealtimeEvent } from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';
import { lockBaseStream, outboxFloor, readBaseEvents } from '../data/outbox.js';
import { AppError } from '../lib/errors.js';
import { allFieldsVisible, type FieldVisibility, projectEvent } from './projection.js';

/** Tries for the base's stream lock (an in-flight writer holds it shared) before giving up. */
const LOCK_ATTEMPTS = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `GET /api/bases/:baseId/events?since=<seq>` (ADR-003 §5): the events a client missed,
 * oldest first, through the same projection as the socket. `since` below the retention floor is
 * 410 `EVENTS_EXPIRED`: the client refetches its open views instead. Pages are capped at
 * `EVENTS_PAGE_MAX`; filtered-out events still advance `next`.
 */
export function realtimeRoutes(routes: RouteRegistry, deps: { visibility?: FieldVisibility } = {}) {
  routes.endpoint(
    contracts.events.list,
    // The events carry record data: a token needs data.records:read.
    { resource: 'base', action: 'base:read', token: 'data.records:read' },
    async (c, { query }) => {
      const { tx, resource, principal } = c.var;
      let locked = false;
      for (let attempt = 0; attempt < LOCK_ATTEMPTS && !locked; attempt++) {
        if (attempt > 0) await sleep(10 * 2 ** attempt);
        locked = await lockBaseStream(tx, resource.id);
      }
      if (!locked) {
        throw new AppError('SERVICE_UNAVAILABLE', { detail: 'Busy. Try again shortly.' });
      }
      if (query.since < (await outboxFloor(tx))) {
        throw new AppError('EVENTS_EXPIRED', {
          detail: 'These events are past the retention window. Reload the data instead.',
        });
      }
      // One more than asked, to know whether there is another page.
      const rows = await readBaseEvents(tx, resource.id, query.since, query.limit + 1);
      const page = rows.slice(0, query.limit);
      const viewer = { userId: principal.user.id, role: resource.role };
      const events = page
        .map((row) => projectEvent(row, viewer, deps.visibility ?? allFieldsVisible))
        .filter((e): e is RealtimeEvent => e !== null);
      return {
        events,
        next: page.at(-1)?.id ?? query.since,
        hasMore: rows.length > query.limit,
      };
    }
  );
}
