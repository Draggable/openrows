import type { BaseCollaborator, BaseRole, UserRole } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import { FIXTURE_BASE_ID, FIXTURE_TOKEN, fakeAirtable } from './__fixtures__/fake.js';
import { type AirtableCollaborators, createAirtableClient } from './client.js';
import {
  COLLABORATORS_FORBIDDEN,
  decideRaises,
  planCollaborators,
  readCollaborators,
  roleForLevel,
} from './collaborators.js';

const instant = async () => {};

const person = (email: string | null, permissionLevel: string) => ({
  email,
  userId: `usr${(email ?? 'x').slice(0, 5)}`,
  permissionLevel,
});

const source = (over: Partial<AirtableCollaborators> = {}): AirtableCollaborators => ({
  individualCollaborators: { baseCollaborators: [], workspaceCollaborators: [] },
  ...over,
});

const member = (
  email: string,
  workspaceRole: UserRole | null,
  baseRole: BaseRole | null = null,
  userId = `user-${email}`
): BaseCollaborator => ({
  userId,
  email,
  name: email.split('@')[0] ?? null,
  avatarUrl: null,
  workspaceRole,
  baseRole,
  role: (workspaceRole ?? baseRole) as UserRole,
});

describe('Airtable collaborators', () => {
  it('maps permission levels to base roles, never a workspace owner', () => {
    expect(roleForLevel('owner')).toBe('creator');
    expect(roleForLevel('create')).toBe('creator');
    expect(roleForLevel('edit')).toBe('editor');
    expect(roleForLevel('comment')).toBe('commenter');
    expect(roleForLevel('read')).toBe('read_only');
    for (const level of ['none', 'interfaceOnly', 'permissionSetOnly', 'constructor', 'OWNER']) {
      expect(roleForLevel(level), level).toBeNull();
    }
  });

  it('plans one role per email, the higher of base and workspace access', () => {
    const plan = planCollaborators(
      source({
        individualCollaborators: {
          baseCollaborators: [
            person('Ada@Example.test', 'comment'),
            person('grace@example.test', 'create'),
          ],
          workspaceCollaborators: [
            person('ada@example.test', 'edit'),
            person('grace@example.test', 'read'),
            person('linus@example.test', 'read'),
          ],
        },
      })
    );
    expect(plan.people).toEqual([
      { email: 'ada@example.test', level: 'edit', role: 'editor' },
      { email: 'grace@example.test', level: 'create', role: 'creator' },
      { email: 'linus@example.test', level: 'read', role: 'read_only' },
    ]);
    expect(plan.report.notApplied).toEqual([]);
  });

  it('lists unknown levels and people without an email instead of applying them', () => {
    const plan = planCollaborators(
      source({
        individualCollaborators: {
          baseCollaborators: [
            person('none@example.test', 'none'),
            person('iface@example.test', 'interfaceOnly'),
            person('set@example.test', 'permissionSetOnly'),
            person(null, 'edit'),
          ],
          workspaceCollaborators: [],
        },
      })
    );
    expect(plan.people).toEqual([]);
    expect(plan.report.notApplied.map((p) => [p.email, p.level])).toEqual([
      ['usrx', 'edit'],
      ['none@example.test', 'none'],
      ['iface@example.test', 'interfaceOnly'],
      ['set@example.test', 'permissionSetOnly'],
    ]);
    expect(plan.report.notApplied[0]?.message).toContain('no email');
    expect(plan.report.notApplied[1]?.message).toContain('no access');
    expect(plan.report.notApplied[2]?.message).toContain("interfaces aren't imported");
    expect(plan.report.notApplied[3]?.message).toContain('"permissionSetOnly" level');
  });

  it('uses a known level when another of the same person is unknown', () => {
    const plan = planCollaborators(
      source({
        individualCollaborators: {
          baseCollaborators: [person('ada@example.test', 'none')],
          workspaceCollaborators: [person('ada@example.test', 'comment')],
        },
      })
    );
    expect(plan.people).toEqual([
      { email: 'ada@example.test', level: 'comment', role: 'commenter' },
    ]);
    expect(plan.report.notApplied).toEqual([]);
  });

  it('falls back to the deprecated `collaborators` key only without the new one', () => {
    const old = planCollaborators({
      collaborators: {
        baseCollaborators: [person('old@example.test', 'edit')],
        workspaceCollaborators: [],
      },
    });
    expect(old.people.map((p) => p.email)).toEqual(['old@example.test']);
    const both = planCollaborators({
      individualCollaborators: {
        baseCollaborators: [person('new@example.test', 'read')],
        workspaceCollaborators: [],
      },
      collaborators: {
        baseCollaborators: [person('old@example.test', 'edit')],
        workspaceCollaborators: [],
      },
    });
    expect(both.people.map((p) => p.email)).toEqual(['new@example.test']);
  });

  it('lists groups, open invitations and interface-only people, and gives them nothing', () => {
    const plan = planCollaborators(
      source({
        individualCollaborators: {
          baseCollaborators: [
            person('ada@example.test', 'edit'),
            // Still invited: listed as an invitation, never given a role.
            person('pending@example.test', 'edit'),
          ],
          workspaceCollaborators: [],
        },
        groupCollaborators: {
          baseCollaborators: [{ groupId: 'ugp1', name: 'Design team', permissionLevel: 'edit' }],
          workspaceCollaborators: [
            { groupId: 'ugp2', name: 'Everyone', permissionLevel: 'read' },
            { groupId: 'ugp2', name: 'Everyone', permissionLevel: 'read' },
          ],
        },
        inviteLinks: {
          baseInviteLinks: [
            { invitedEmail: 'Pending@example.test', permissionLevel: 'edit' },
            // A shared invite link (no email): not recreated, not listed.
            { invitedEmail: null, permissionLevel: 'read' },
          ],
          workspaceInviteLinks: [{ invitedEmail: 'later@example.test', permissionLevel: 'read' }],
        },
        interfaces: {
          pbdInterface0001: {
            name: 'Launch dashboard',
            individualCollaborators: [
              person('viewer@example.test', 'read'),
              // Also on the base: not interface-only.
              person('ada@example.test', 'read'),
            ],
            groupCollaborators: [{ groupId: 'ugp3', name: 'Clients', permissionLevel: 'read' }],
          },
        },
      })
    );
    expect(plan.people).toEqual([{ email: 'ada@example.test', level: 'edit', role: 'editor' }]);
    expect(plan.report.invitations).toEqual([
      { email: 'pending@example.test', level: 'edit' },
      { email: 'later@example.test', level: 'read' },
    ]);
    expect(plan.report.groups).toEqual([
      { name: 'Design team', level: 'edit', scope: 'base' },
      { name: 'Everyone', level: 'read', scope: 'workspace' },
      { name: 'Clients', level: 'read', scope: 'interface' },
    ]);
    expect(plan.report.interfaceOnly).toEqual([
      { email: 'viewer@example.test', level: 'read', interface: 'Launch dashboard' },
    ]);
  });

  it('raises only workspace members whose access is lower', () => {
    const people = [
      { email: 'owner@example.test', level: 'owner', role: 'creator' as const },
      { email: 'me@example.test', level: 'owner', role: 'creator' as const },
      { email: 'editor@example.test', level: 'create', role: 'creator' as const },
      { email: 'creator@example.test', level: 'edit', role: 'editor' as const },
      { email: 'same@example.test', level: 'comment', role: 'commenter' as const },
      { email: 'based@example.test', level: 'edit', role: 'editor' as const },
      { email: 'baseonly@example.test', level: 'edit', role: 'editor' as const },
      { email: 'stranger@example.test', level: 'read', role: 'read_only' as const },
    ];
    const members = [
      member('Owner@Example.test', 'owner'),
      member('me@example.test', 'creator', null, 'importer'),
      member('editor@example.test', 'editor'),
      member('creator@example.test', 'creator'),
      member('same@example.test', 'commenter'),
      // Already an editor here through a base role.
      member('based@example.test', 'read_only', 'editor'),
      // Has the base without being a workspace member: never touched.
      member('baseonly@example.test', null, 'commenter'),
    ];
    const decided = decideRaises(people, members, 'importer');
    expect(decided.raise.map((r) => [r.member.email, r.person.role])).toEqual([
      ['editor@example.test', 'creator'],
    ]);
    expect(decided.unchanged).toBe(5);
    expect(decided.notMembers.map((p) => p.email)).toEqual([
      'baseonly@example.test',
      'stranger@example.test',
    ]);
  });

  it("reads the fixture base's collaborators, asking for collaborators only", async () => {
    const fake = fakeAirtable();
    const client = createAirtableClient(FIXTURE_TOKEN, { http: fake.http, sleep: instant });
    const read = await readCollaborators(client, FIXTURE_BASE_ID);
    if (!('plan' in read)) throw new Error(read.unavailable);
    expect(read.plan.people).toEqual([
      { email: 'ada@airtable-fixture.test', level: 'create', role: 'creator' },
      { email: 'linus@airtable-fixture.test', level: 'comment', role: 'commenter' },
      { email: 'grace@airtable-fixture.test', level: 'owner', role: 'creator' },
    ]);
    expect(read.plan.report.notApplied.map((p) => p.email)).toEqual([
      'katherine@airtable-fixture.test',
    ]);
    expect(read.plan.report.groups.map((g) => g.name)).toEqual(['Design team', 'Everyone']);
    const url = new URL(fake.requests.at(-1)?.url ?? '');
    expect(url.pathname).toBe(`/v0/meta/bases/${FIXTURE_BASE_ID}`);
    expect([...url.searchParams.entries()]).toEqual([['include[]', 'collaborators']]);
  });

  it('turns a refusal, an outage or an unexpected answer into one report line', async () => {
    const client = (fake: ReturnType<typeof fakeAirtable>) =>
      createAirtableClient(FIXTURE_TOKEN, { http: fake.http, sleep: instant });
    const forbidden = await readCollaborators(
      client(fakeAirtable({ collaboratorsStatus: 403 })),
      FIXTURE_BASE_ID
    );
    expect(forbidden).toEqual({ unavailable: COLLABORATORS_FORBIDDEN });
    const down = await readCollaborators(
      client(fakeAirtable({ collaboratorsStatus: 503 })),
      FIXTURE_BASE_ID
    );
    expect('unavailable' in down && down.unavailable).toContain("Airtable didn't answer (503)");
    const odd = await readCollaborators(
      client(fakeAirtable({ collaborators: { id: FIXTURE_BASE_ID, individualCollaborators: 3 } })),
      FIXTURE_BASE_ID
    );
    expect('unavailable' in odd && odd.unavailable).toContain('unexpected answer');
    const none = await readCollaborators(
      client(fakeAirtable({ collaborators: { id: FIXTURE_BASE_ID } })),
      FIXTURE_BASE_ID
    );
    expect('unavailable' in none && none.unavailable).toContain('unexpected answer');
    for (const r of [forbidden, down, odd, none]) {
      expect(JSON.stringify(r)).not.toContain(FIXTURE_TOKEN);
    }
  });
});
