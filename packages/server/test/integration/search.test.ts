import { SEARCH_PAGE_MAX } from '@openrows/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import { baseMembers, interfaceMembers, interfaces, type users } from '../../src/db/index.js';
import type { FieldVisibility } from '../../src/realtime/projection.js';
import { SEARCH_TIME_BUDGET_MS, searchRecords } from '../../src/search/service.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import {
  addMember,
  createBase,
  createSession,
  createToken,
  createUser,
  createWorkspace,
} from '../helpers/factories.js';

type User = typeof users.$inferSelect;
/** A JSON answer, of whatever shape: the assertions check it. */
type Json = ReturnType<typeof JSON.parse>;

interface Hit {
  id: string;
  baseId: string;
  baseName: string;
  tableId: string;
  tableName: string;
  name: string;
  matches: { fieldId: string; fieldName: string; text: string }[];
}

/**
 * Record search (`GET /api/v1/search`) as openrows_app: hits across tables and bases the
 * caller reads, nothing from bases (or workspaces) they don't, the same answer through a
 * personal access token only inside its grants, hidden fields neither searched nor answered,
 * and pages that continue with `offset`.
 */
describe('record search', () => {
  const t = useTestDb();
  /** Notes of the Contacts table, hidden from everyone by the app's FieldVisibility. */
  let hiddenNotes = '';
  const visibility: FieldVisibility = {
    hiddenFields: () => new Set(hiddenNotes ? [hiddenNotes] : []),
  };
  let app: ReturnType<typeof testApp>['app'];

  let alice: User;
  let aliceCookie: string;
  let bobCookie: string;
  let carolCookie: string;
  let loneCookie: string;
  let readerCookie: string;
  let guestCookie: string;
  let salesId: string;
  let supportId: string;
  let hiringId: string;
  let contactsId: string;
  let dealsId: string;
  let ticketsId: string;
  let bulkId: string;

  type Caller = { cookie?: string; bearer?: string };
  const call = async (
    who: Caller,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: Json }> => {
    const headers = new Headers();
    if (who.cookie) headers.set('cookie', `${SESSION_COOKIE}=${who.cookie}`);
    if (who.bearer) headers.set('authorization', `Bearer ${who.bearer}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const search = (who: Caller, params: Record<string, string>) =>
    call(who, 'GET', `/api/v1/search?${new URLSearchParams(params)}`);
  const ids = (hits: Hit[]) => hits.map((h) => h.id);

  /** A table made through the v1 API; answers its id and its field ids by name. */
  async function table(
    who: Caller,
    baseId: string,
    name: string,
    fields: { name: string; type: string; options?: Json }[]
  ) {
    const res = await call(who, 'POST', `/api/v1/meta/bases/${baseId}/tables`, { name, fields });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byName = Object.fromEntries(
      res.body.fields.map((f: { name: string; id: string }) => [f.name, f.id])
    ) as Record<string, string>;
    return { id: res.body.id as string, fields: byName };
  }

  /** Records through the v1 API (10 a request), answering their ids in order. */
  async function records(who: Caller, baseId: string, tableId: string, cells: Json[]) {
    const out: string[] = [];
    for (let i = 0; i < cells.length; i += 10) {
      const res = await call(who, 'POST', `/api/v1/${baseId}/${tableId}`, {
        records: cells.slice(i, i + 10).map((fields) => ({ fields })),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      out.push(...res.body.records.map((r: { id: string }) => r.id));
    }
    return out;
  }

  const recordIds: Record<string, string> = {};

  beforeAll(async () => {
    app = testApp({ db: t.appDb, visibility }).app;
    const w1 = await createWorkspace(t.db, { name: 'Alice workspace' });
    alice = w1.owner;
    aliceCookie = await createSession(t.db, alice);
    const sales = await createBase(t.db, w1.workspace.id, { name: 'Sales' });
    const support = await createBase(t.db, w1.workspace.id, { name: 'Support' });
    salesId = sales.id;
    supportId = support.id;

    // Bob's own workspace, which Alice isn't a member of.
    const w2 = await createWorkspace(t.db, { name: 'Bob workspace' });
    bobCookie = await createSession(t.db, w2.owner);
    const hiring = await createBase(t.db, w2.workspace.id, { name: 'Hiring' });
    hiringId = hiring.id;

    // Carol collaborates on Sales only (no workspace role).
    const carol = await createUser(t.db);
    carolCookie = await createSession(t.db, carol);
    await t.db
      .insert(baseMembers)
      .values({ workspaceId: w1.workspace.id, baseId: salesId, userId: carol.id, role: 'editor' });
    // A user with no bases at all.
    loneCookie = await createSession(t.db, await createUser(t.db));
    // An interface-only collaborator on an interface of Sales: no role on the base itself.
    const guest = await createUser(t.db);
    guestCookie = await createSession(t.db, guest);
    const [iface] = await t.db
      .insert(interfaces)
      .values({ workspaceId: w1.workspace.id, baseId: salesId, name: 'Portal' })
      .returning();
    if (!iface) throw new Error('no interface');
    await t.db.insert(interfaceMembers).values({
      workspaceId: w1.workspace.id,
      interfaceId: iface.id,
      userId: guest.id,
      role: 'editor',
    });
    // A read-only member of Alice's workspace.
    readerCookie = await createSession(t.db, await addMember(t.db, w1.workspace.id, 'read_only'));

    const asAlice = { cookie: aliceCookie };
    const contacts = await table(asAlice, salesId, 'Contacts', [
      { name: 'Name', type: 'singleLineText' },
      { name: 'Email', type: 'email' },
      { name: 'Notes', type: 'multilineText' },
    ]);
    contactsId = contacts.id;
    const deals = await table(asAlice, salesId, 'Deals', [
      { name: 'Deal', type: 'singleLineText' },
      {
        name: 'Stage',
        type: 'singleSelect',
        options: { choices: [{ name: 'Lovelace pilot' }, { name: 'Closed' }] },
      },
    ]);
    dealsId = deals.id;
    const tickets = await table(asAlice, supportId, 'Tickets', [
      { name: 'Subject', type: 'singleLineText' },
      { name: 'Reporter', type: 'email' },
    ]);
    ticketsId = tickets.id;
    const hiringTable = await table({ cookie: bobCookie }, hiringId, 'Candidates', [
      { name: 'Name', type: 'singleLineText' },
    ]);

    const [ada, grace, adaGone] = await records(asAlice, salesId, contactsId, [
      { Name: 'Ada Lovelace', Email: 'ada@example.test', Notes: 'Met at the analytical fair' },
      { Name: 'Grace Hopper', Email: 'grace@example.test', Notes: 'Knows Ada Lovelace well' },
      { Name: 'Ada Lovelace (old)' },
    ]);
    recordIds['ada'] = ada as string;
    recordIds['grace'] = grace as string;
    const del = await call(
      asAlice,
      'DELETE',
      `/api/v1/${salesId}/${contactsId}?records[]=${adaGone}`
    );
    expect(del.status).toBe(200);
    const [deal] = await records(asAlice, salesId, dealsId, [
      { Deal: 'Engine order', Stage: 'Lovelace pilot' },
      { Deal: 'Unrelated', Stage: 'Closed' },
    ]);
    recordIds['deal'] = deal as string;
    const [ticket] = await records(asAlice, supportId, ticketsId, [
      { Subject: 'Printer jam', Reporter: 'lovelace@example.test' },
    ]);
    recordIds['ticket'] = ticket as string;
    const [candidate] = await records({ cookie: bobCookie }, hiringId, hiringTable.id, [
      { Name: 'Ada Lovelace' },
    ]);
    recordIds['candidate'] = candidate as string;

    // 25 matching records for the paging tests, in a table of their own in Support.
    const bulk = await table(asAlice, supportId, 'Bulk', [
      { name: 'Name', type: 'singleLineText' },
    ]);
    bulkId = bulk.id;
    await records(
      asAlice,
      supportId,
      bulkId,
      Array.from({ length: 25 }, (_, i) => ({ Name: `Zebra ${i}` }))
    );
    hiddenNotes = '';
  });

  it('finds records across the tables of a base and across bases, with their context', async () => {
    const res = await search({ cookie: aliceCookie }, { q: 'lovelace' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const hits = res.body.records as Hit[];
    // Contacts and Deals of Sales, Tickets of Support; never the deleted record or Bob's.
    expect(ids(hits).sort()).toEqual(
      [recordIds['ada'], recordIds['grace'], recordIds['deal'], recordIds['ticket']].sort()
    );
    expect(res.body.offset).toBeUndefined();
    const ada = hits.find((h) => h.id === recordIds['ada']);
    expect(ada).toMatchObject({
      baseId: salesId,
      baseName: 'Sales',
      tableId: contactsId,
      tableName: 'Contacts',
      name: 'Ada Lovelace',
      matches: [],
    });
    // A match outside the primary field says which field matched.
    const grace = hits.find((h) => h.id === recordIds['grace']);
    expect(grace?.name).toBe('Grace Hopper');
    expect(grace?.matches).toEqual([
      { fieldId: expect.any(String), fieldName: 'Notes', text: 'Knows Ada Lovelace well' },
    ]);
    expect(hits.find((h) => h.id === recordIds['deal'])?.matches).toEqual([
      { fieldId: expect.any(String), fieldName: 'Stage', text: 'Lovelace pilot' },
    ]);
    expect(hits.find((h) => h.id === recordIds['ticket'])).toMatchObject({
      baseName: 'Support',
      tableName: 'Tickets',
      name: 'Printer jam',
      matches: [{ fieldName: 'Reporter', text: 'lovelace@example.test' }],
    });
    // Ignoring case, and in the caller's base order: Sales (older) before Support.
    const upper = await search({ cookie: aliceCookie }, { q: 'LOVELACE' });
    expect(ids(upper.body.records)).toEqual(ids(hits));
    expect(hits.at(-1)?.baseId).toBe(supportId);
    // Read-only members read records, so they find them too.
    const reader = await search({ cookie: readerCookie }, { q: 'lovelace' });
    expect(ids(reader.body.records)).toEqual(ids(hits));
  });

  it('searches the base named first before the others, or only the base named', async () => {
    const first = await search({ cookie: aliceCookie }, { q: 'lovelace', firstBaseId: supportId });
    expect((first.body.records as Hit[])[0]?.id).toBe(recordIds['ticket']);
    expect(first.body.records).toHaveLength(4);

    const only = await search({ cookie: aliceCookie }, { q: 'lovelace', baseId: supportId });
    expect(ids(only.body.records)).toEqual([recordIds['ticket']]);
  });

  it("never answers records of a base the caller can't read", async () => {
    // Bob sees his own candidate, never Alice's records, and Alice never sees his.
    const bob = await search({ cookie: bobCookie }, { q: 'lovelace' });
    expect(bob.status).toBe(200);
    expect(ids(bob.body.records)).toEqual([recordIds['candidate']]);
    const aliceHits = (await search({ cookie: aliceCookie }, { q: 'lovelace' })).body
      .records as Hit[];
    expect(aliceHits.some((h) => h.baseId === hiringId)).toBe(false);

    // Naming a base outside your access is a 404, as on every route of it.
    const named = await search({ cookie: aliceCookie }, { q: 'lovelace', baseId: hiringId });
    expect(named.status).toBe(404);
    expect(named.body.error.type).toBe('NOT_FOUND');
    // firstBaseId of someone else's base changes nothing.
    const first = await search({ cookie: aliceCookie }, { q: 'lovelace', firstBaseId: hiringId });
    expect(ids(first.body.records)).toEqual(ids(aliceHits));

    // A base-only collaborator of Sales sees Sales and nothing else of the workspace.
    const carol = await search({ cookie: carolCookie }, { q: 'lovelace' });
    expect(carol.status).toBe(200);
    expect(new Set((carol.body.records as Hit[]).map((h) => h.baseId))).toEqual(new Set([salesId]));
    expect(carol.body.records).toHaveLength(3);
    expect(
      (await search({ cookie: carolCookie }, { q: 'lovelace', baseId: supportId })).status
    ).toBe(404);

    // An interface-only collaborator finds nothing of the interface's base.
    const guest = await search({ cookie: guestCookie }, { q: 'lovelace' });
    expect(guest.body).toEqual({ records: [] });
    expect((await search({ cookie: guestCookie }, { q: 'lovelace', baseId: salesId })).status).toBe(
      404
    );
  });

  it('answers an empty list to someone without bases, and to a query nothing matches', async () => {
    const lone = await search({ cookie: loneCookie }, { q: 'lovelace' });
    expect(lone.status).toBe(200);
    expect(lone.body).toEqual({ records: [] });
    const none = await search({ cookie: aliceCookie }, { q: 'no such text anywhere' });
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ records: [] });
  });

  it('refuses the anonymous, and queries too short, too long or malformed', async () => {
    const anonymous = await search({}, { q: 'lovelace' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.type).toBe('AUTHENTICATION_REQUIRED');
    const malformed: Record<string, string>[] = [
      {},
      { q: '' },
      { q: 'ad' },
      { q: '   ad   ' },
      { q: 'x'.repeat(201) },
      { q: 'lovelace', pageSize: String(SEARCH_PAGE_MAX + 1) },
      { q: 'lovelace', pageSize: '0' },
      { q: 'lovelace', baseId: 'not-a-uuid' },
      { q: 'lovelace', offset: 'garbage' },
      { q: 'lovelace', other: 'x' },
    ];
    for (const params of malformed) {
      const res = await search({ cookie: aliceCookie }, params);
      expect(res.status, JSON.stringify(params)).toBe(422);
    }
  });

  it('pages through many hits with offset, without repeats', async () => {
    const seen: string[] = [];
    let offset: string | undefined;
    let pages = 0;
    do {
      const res = await search(
        { cookie: aliceCookie },
        { q: 'zebra', pageSize: '10', ...(offset ? { offset } : {}) }
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.records.length).toBeLessThanOrEqual(10);
      seen.push(...ids(res.body.records));
      offset = res.body.offset;
      pages++;
    } while (offset && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);

    // The default page is 20 records.
    const first = await search({ cookie: aliceCookie }, { q: 'zebra' });
    expect(first.body.records).toHaveLength(20);
    expect(first.body.offset).toEqual(expect.any(String));

    // An offset of a base the caller can't reach is refused, not followed.
    const foreign = Buffer.from(JSON.stringify({ b: hiringId })).toString('base64url');
    expect((await search({ cookie: aliceCookie }, { q: 'zebra', offset: foreign })).status).toBe(
      422
    );
  });

  it('stops a page at its time budget and continues with offset', async () => {
    // A clock that jumps past the budget after every reading: one table per page.
    let clock = 0;
    const deps = { db: t.appDb, visibility, now: () => (clock += SEARCH_TIME_BUDGET_MS) };
    const principal = {
      user: alice,
      session: { idHash: 'x', expiresAt: new Date(Date.now() + 60_000), createdAt: new Date() },
    };
    const query = { q: 'lovelace', pageSize: 20 };
    const tablesSeen: string[] = [];
    const seen: string[] = [];
    let offset: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await searchRecords(deps, principal, {
        ...query,
        ...(offset ? { offset } : {}),
      });
      tablesSeen.push(...new Set(page.records.map((h) => h.tableId)));
      seen.push(...ids(page.records));
      offset = page.offset;
      if (!offset) break;
    }
    // Every page searched one table; together they found what one page finds.
    expect(new Set(tablesSeen).size).toBe(tablesSeen.length);
    expect(seen.sort()).toEqual(
      [recordIds['ada'], recordIds['grace'], recordIds['deal'], recordIds['ticket']].sort()
    );
  });

  it('neither searches nor answers fields hidden from the caller', async () => {
    const res = await search({ cookie: aliceCookie }, { q: 'analytical' });
    expect(ids(res.body.records)).toEqual([recordIds['ada']]);
    hiddenNotes = (
      await call({ cookie: aliceCookie }, 'GET', `/api/v1/meta/bases/${salesId}/tables`)
    ).body.tables
      .find((tb: { id: string }) => tb.id === contactsId)
      .fields.find((f: { name: string }) => f.name === 'Notes').id;
    try {
      const hidden = await search({ cookie: aliceCookie }, { q: 'analytical' });
      expect(hidden.body.records).toEqual([]);
      const grace = (await search({ cookie: aliceCookie }, { q: 'lovelace' })).body.records.find(
        (h: Hit) => h.id === recordIds['grace']
      );
      // Grace matched only in Notes.
      expect(grace).toBeUndefined();
    } finally {
      hiddenNotes = '';
    }
  });

  it('answers a personal access token only inside its grants and with the records scope', async () => {
    const granted = await createToken(t.db, alice, { baseIds: [supportId] });
    const res = await search({ bearer: granted.token }, { q: 'lovelace' });
    expect(res.status).toBe(200);
    expect(ids(res.body.records)).toEqual([recordIds['ticket']]);
    expect(
      (await search({ bearer: granted.token }, { q: 'lovelace', baseId: salesId })).status
    ).toBe(404);

    const schemaOnly = await createToken(t.db, alice, {
      scopes: ['schema.bases:read'],
      baseIds: [salesId, supportId],
    });
    const refused = await search({ bearer: schemaOnly.token }, { q: 'lovelace' });
    expect(refused.status).toBe(403);
  });

  it('leaves the prototype path unmounted', async () => {
    const res = await call({ cookie: aliceCookie }, 'GET', '/api/search?q=lovelace');
    expect(res.status).toBe(404);
  });
});
