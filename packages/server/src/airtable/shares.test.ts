import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_BASE_ID, FIXTURE_TOKEN, fakeAirtable } from './__fixtures__/fake.js';
import { type AirtableCollaborators, type AirtableShare, createAirtableClient } from './client.js';
import {
  airtableUserEmails,
  type KnownView,
  planShares,
  readShares,
  SHARES_FORBIDDEN,
  SHARES_NOT_RECREATED,
  SHARES_TOKEN_REJECTED,
  sharesReport,
} from './shares.js';

const instant = async () => {};
const client = (fake = fakeAirtable()) =>
  createAirtableClient(FIXTURE_TOKEN, { http: fake.http, sleep: instant });

const KANBAN = '01900000-0000-7000-8000-00000000000a';
const PROJECTS = '01900000-0000-7000-8000-00000000000b';

/** The fixture base's views as the import leaves them: a kanban and a grid made, a form not. */
const views = new Map<string, KnownView>([
  [
    'viwProjKanban0001',
    {
      table: 'Projects',
      type: 'kanban',
      name: 'By status',
      imported: { tableId: PROJECTS, viewId: KANBAN, name: 'By status' },
    },
  ],
  ['viwTaskForm000001', { table: 'Tasks', type: 'form', name: 'New task', imported: null }],
  [
    'viwProjGrid000001',
    { table: 'Projects', type: 'grid', name: 'All projects', imported: null, gone: true },
  ],
  ['viwProjGantt00001', { table: 'Projects', type: 'block', name: 'Gantt', imported: null }],
]);

const share = (over: Partial<AirtableShare>): AirtableShare => ({
  shareId: 'shrSome0000000001',
  type: 'view',
  state: 'enabled',
  createdByUserId: 'usrNobody0000001',
  createdTime: '2024-01-01T00:00:00.000Z',
  isPasswordProtected: false,
  restrictedToEmailDomains: [],
  restrictedToEnterpriseMembers: false,
  ...over,
});

describe('Airtable share links', () => {
  it("lists a base's shares with one GET of Airtable's List shares, the token prefix dropped", async () => {
    const fake = fakeAirtable();
    const read = await client(fake).shares(FIXTURE_BASE_ID);
    if (read.status !== 'ok') throw new Error(read.status);
    expect(read.unreadable).toBe(0);
    expect(read.shares.map((s) => `${s.type}:${s.state}:${s.shareId}`)).toEqual([
      'base:enabled:shrBaseFixture001',
      'view:enabled:shrKanbanFixture1',
      'view:enabled:shrFormFixture001',
      'view:disabled:shrGridFixture001',
      'blockInstallation:disabled:shrBlockFixture01',
    ]);
    expect(read.shares[0]).toEqual({
      shareId: 'shrBaseFixture001',
      type: 'base',
      state: 'enabled',
      createdByUserId: 'usrGrace00000001',
      createdTime: '2024-02-01T09:00:00.000Z',
      effectiveEmailDomainAllowList: ['airtable-fixture.test'],
      isPasswordProtected: true,
      restrictedToEmailDomains: ['airtable-fixture.test'],
      restrictedToEnterpriseMembers: false,
    });
    expect(JSON.stringify(read)).not.toContain('shareTokenPrefix');
    expect(fake.requests).toEqual([
      expect.objectContaining({
        url: `https://api.airtable.com/v0/meta/bases/${FIXTURE_BASE_ID}/shares`,
        method: 'GET',
        authorization: `Bearer ${FIXTURE_TOKEN}`,
      }),
    ]);
    await expect(client().shares('app/../../v0/meta/bases')).rejects.toThrow('bad base id');
  });

  it("says once why shares weren't listed on a 401, 403 or 404, and never throws", async () => {
    for (const [status, message] of [
      [401, SHARES_TOKEN_REJECTED],
      [403, SHARES_FORBIDDEN],
      [404, SHARES_FORBIDDEN],
    ] as const) {
      const fake = fakeAirtable({ sharesStatus: status });
      const read = await readShares(client(fake), FIXTURE_BASE_ID);
      expect(read).toEqual({ unavailable: message });
      expect(fake.requests).toHaveLength(1);
      const report = sharesReport(read, views, new Map());
      expect(report).toMatchObject({ unavailable: message, total: 0, shares: [] });
      expect(report.note).toBe(SHARES_NOT_RECREATED);
    }
    expect(SHARES_FORBIDDEN).toContain('workspacesAndBases.shares:manage');
    expect(SHARES_FORBIDDEN).toContain('Everything else was imported.');
  });

  it("records other failures as a reason, without the token or Airtable's text", async () => {
    const down = await readShares(client(fakeAirtable({ sharesStatus: 503 })), FIXTURE_BASE_ID);
    expect(down).toMatchObject({ unavailable: expect.stringContaining("didn't answer (503)") });
    const odd = await readShares(
      client(fakeAirtable({ shares: { shares: 'not a list' } })),
      FIXTURE_BASE_ID
    );
    expect(odd).toMatchObject({ unavailable: expect.stringContaining('unexpected answer') });
    expect(JSON.stringify([down, odd])).not.toContain(FIXTURE_TOKEN);
  });

  it("counts entries it can't read and keeps the rest", async () => {
    const fake = fakeAirtable({
      shares: {
        shares: [
          { shareId: 'shrGood000000001', type: 'base', state: 'enabled' },
          { type: 'view', state: 'enabled' },
          'nonsense',
        ],
      },
    });
    const read = await readShares(client(fake), FIXTURE_BASE_ID);
    if (!('listed' in read)) throw new Error('not listed');
    const report = sharesReport(read, views, new Map());
    expect(report).toMatchObject({ total: 1, unreadable: 2, unavailable: null });
    expect(report.shares[0]).toMatchObject({
      shareId: 'shrGood000000001',
      isPasswordProtected: false,
      restrictedToEmailDomains: [],
      effectiveEmailDomainAllowList: null,
      restrictedToEnterpriseMembers: false,
      canBeSynced: null,
      createdTime: null,
      createdByUserId: null,
      createdByEmail: null,
    });
  });

  it('maps view links to the imported views and lists the rest as not recreated', async () => {
    const read = await readShares(client(), FIXTURE_BASE_ID);
    if (!('listed' in read)) throw new Error('not listed');
    const collaborators = JSON.parse(
      readFileSync(new URL('./__fixtures__/collaborators.json', import.meta.url), 'utf8')
    ) as AirtableCollaborators;
    const report = sharesReport(read, views, airtableUserEmails(collaborators));
    expect(report).toMatchObject({
      unavailable: null,
      note: SHARES_NOT_RECREATED,
      total: 5,
      enabled: 3,
      disabled: 2,
      byType: { base: 1, view: 3, blockInstallation: 1, other: 0 },
      viewsImported: 1,
      viewsNotImported: 2,
      unreadable: 0,
    });
    const [base, kanban, form, grid, block] = report.shares;
    expect(base).toMatchObject({
      type: 'base',
      isPasswordProtected: true,
      restrictedToEmailDomains: ['airtable-fixture.test'],
      effectiveEmailDomainAllowList: ['airtable-fixture.test'],
      createdByUserId: 'usrGrace00000001',
      createdByEmail: 'grace@airtable-fixture.test',
      view: null,
      message: expect.stringContaining('whole base. Not recreated'),
    });
    expect(kanban).toMatchObject({
      airtableViewId: 'viwProjKanban0001',
      view: { tableId: PROJECTS, table: 'Projects', viewId: KANBAN, name: 'By status' },
      canBeSynced: true,
      createdByEmail: 'ada@airtable-fixture.test',
      message:
        'A link to the view "By status" in Projects. Not recreated: use "Share view" on the imported view to make one.',
    });
    expect(form).toMatchObject({
      airtableViewId: 'viwTaskForm000001',
      view: null,
      message: expect.stringContaining("Form views aren't imported"),
    });
    expect(grid).toMatchObject({
      state: 'disabled',
      view: null,
      // Empty: Airtable lets nobody open it; kept apart from "no restriction" (null).
      effectiveEmailDomainAllowList: [],
      restrictedToEnterpriseMembers: true,
      canBeSynced: false,
      // Not in Airtable's collaborators answer: no other lookup is made.
      createdByUserId: 'usrSomeoneElse01',
      createdByEmail: null,
      message: expect.stringContaining('deleted from the new base'),
    });
    expect(block).toMatchObject({
      type: 'blockInstallation',
      blockInstallationId: 'bliFixtureChart01',
      view: null,
      message: expect.stringContaining("extensions aren't imported"),
    });
  });

  it('describes views it never read, other view types and unknown share types', () => {
    const report = planShares(
      [
        share({ viewId: 'viwUnknown0000001' }),
        share({ viewId: null }),
        share({ viewId: 'viwProjGantt00001' }),
        share({ type: 'interfacePage', state: 'paused' }),
      ],
      0,
      views,
      new Map()
    );
    expect(report).toMatchObject({
      total: 4,
      enabled: 3,
      disabled: 0,
      byType: { base: 0, view: 3, blockInstallation: 0, other: 1 },
      viewsImported: 0,
      viewsNotImported: 3,
    });
    expect(report.shares.map((s) => s.message)).toEqual([
      "A link to a view this import didn't read (Airtable's viwUnknown0000001).",
      "A link to a view Airtable didn't name.",
      'A link to the block view "Gantt" in Projects, which wasn\'t imported (see "Views not imported").',
      'A link of Airtable\'s "interfacePage" type: listed only.',
    ]);
    expect(report.shares[3]).toMatchObject({ type: 'interfacePage', state: 'paused' });
  });

  it('reads emails only from the collaborators answer the import already has', () => {
    expect(airtableUserEmails(null).size).toBe(0);
    const emails = airtableUserEmails({
      individualCollaborators: {
        baseCollaborators: [{ userId: 'usrA', email: ' A@Example.test ', permissionLevel: 'edit' }],
        workspaceCollaborators: [{ userId: 'usrB', email: null, permissionLevel: 'read' }],
      },
      interfaces: {
        pbd1: {
          individualCollaborators: [
            { userId: 'usrC', email: 'c@example.test', permissionLevel: 'read' },
          ],
        },
      },
    });
    expect([...emails]).toEqual([
      ['usrA', 'a@example.test'],
      ['usrC', 'c@example.test'],
    ]);
  });

  it('only describes: the importer never creates, changes or deletes a share', () => {
    // Report only (no `createShare`, no insert into `shares`), and Airtable's shares are only
    // listed: no other method or share path in the client.
    for (const file of ['./shares.ts', './import.ts', './client.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/shares\/service|createShare|updateShare|revokeShare/);
      expect(source, file).not.toMatch(/insert\(\s*shares\b/);
    }
    const client = readFileSync(new URL('./client.ts', import.meta.url), 'utf8');
    expect(client).not.toMatch(/method:\s*'(POST|PATCH|PUT|DELETE)'/);
  });
});
