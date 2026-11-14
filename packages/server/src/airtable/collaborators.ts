import {
  AIRTABLE_LEVEL_ROLES,
  type AirtableCollaboratorsReport,
  type BaseCollaborator,
  type BaseRole,
  emptyAirtableCollaboratorsReport,
  USER_ROLES,
  type UserRole,
} from '@openrows/shared';
import { recordAudit } from '../audit/record.js';
import { higherRole } from '../authz/policy.js';
import { listBaseCollaborators, setBaseRole } from '../bases/collaborators.js';
import type { Transaction } from '../db/index.js';
import type { AuditSink, Entitlements } from '../edition/types.js';
import { AppError } from '../lib/errors.js';
import { assertEditorRoom } from '../usage/quota.js';
import type { AirtableClient, AirtableCollaborators } from './client.js';
import { attempt, capped } from './schema.js';

/**
 * Airtable's base collaborators onto the imported base, at the end of a successful import.
 *
 * Airtable's permission level becomes a base role (`AIRTABLE_LEVEL_ROLES`: owner and create →
 * creator, edit → editor, comment → commenter, read → read_only). A person is matched to a
 * workspace member by lower-cased email; someone listed on the base and on its workspace gets
 * the higher of the two. Then:
 *
 * - a workspace member whose access to the new base is lower than that role gets it as a base
 *   role, through `setBaseRole` (which only changes the role of someone who already has
 *   access), in a savepoint each, with the plan's editor seats checked as when a person does it;
 * - a member whose access is already as high, a workspace owner, and the person who ran the
 *   import are left as they are;
 * - everyone else (not a member, a level with no base role, no email), user groups, open
 *   invitations and interface-only people are only listed in the report.
 *
 * Nothing here invites anyone, creates an account, changes a workspace role, sends email or
 * writes an outbox event or notification: the new base only becomes visible to more of the
 * workspace's own members.
 */

/** Why Airtable's collaborators weren't read: a 403 or 404. */
export const COLLABORATORS_FORBIDDEN =
  "The token can't read this base's collaborators (Airtable's \"Get base collaborators\" needs the schema.bases:read scope and access to the base). Nobody was given a base role: share the base by hand.";
/** Something else went wrong reading them. */
export const collaboratorsUnreadable = (detail: string) =>
  `Airtable's collaborators couldn't be read: ${detail} Nobody was given a base role: share the base by hand.`;
/** Reading worked, applying didn't (rolled back). */
export const COLLABORATORS_NOT_APPLIED =
  "Airtable's collaborators couldn't be applied, so nobody was given a base role: share the base by hand.";

export interface PlannedPerson {
  /** Lower-cased. */
  email: string;
  /** The Airtable level the role comes from. */
  level: string;
  role: BaseRole;
}

export interface CollaboratorPlan {
  people: PlannedPerson[];
  /** Report sections that need no database: filled in already. */
  report: AirtableCollaboratorsReport;
}

const rank = (role: UserRole) => USER_ROLES.indexOf(role);

/** The base role of an Airtable level; null for `none`, interface-only and anything unknown. */
export function roleForLevel(level: string): BaseRole | null {
  return Object.hasOwn(AIRTABLE_LEVEL_ROLES, level)
    ? AIRTABLE_LEVEL_ROLES[level as keyof typeof AIRTABLE_LEVEL_ROLES]
    : null;
}

function unappliedMessage(levels: string[]): string {
  if (levels.some((l) => /interface/i.test(l))) {
    return "Airtable gives them interfaces only: interfaces aren't imported, so no base role was given.";
  }
  if (levels.every((l) => l === 'none')) {
    return 'Airtable gives them no access to the base ("none").';
  }
  return `Airtable's "${levels.join('", "')}" level has no base role here.`;
}

const normEmail = (email: string | null | undefined) => email?.trim().toLowerCase() || null;

/**
 * What to do with an Airtable collaborators answer, before looking at the workspace: the
 * people with a base role to compare, and the report's lines that are only listed.
 */
export function planCollaborators(source: AirtableCollaborators): CollaboratorPlan {
  const report = emptyAirtableCollaboratorsReport();
  const individuals = source.individualCollaborators ?? source.collaborators;
  const entries = [
    ...(individuals?.baseCollaborators ?? []),
    ...(individuals?.workspaceCollaborators ?? []),
  ];

  // Open invitations (only if Airtable sent invite links, which aren't asked for): listed.
  const invited = new Set<string>();
  const links = source.inviteLinks;
  for (const link of [...(links?.baseInviteLinks ?? []), ...(links?.workspaceInviteLinks ?? [])]) {
    const email = normEmail(link.invitedEmail);
    if (!email || invited.has(email)) continue;
    invited.add(email);
    capped(report.invitations, { email, level: link.permissionLevel });
  }

  const byEmail = new Map<string, { levels: string[]; best: PlannedPerson | null }>();
  for (const entry of entries) {
    const email = normEmail(entry.email);
    if (!email) {
      capped(report.notApplied, {
        email: entry.userId ?? '',
        level: entry.permissionLevel,
        message: "Airtable gave no email, so they can't be matched to a workspace member.",
      });
      continue;
    }
    const person = byEmail.get(email) ?? { levels: [], best: null };
    byEmail.set(email, person);
    if (!person.levels.includes(entry.permissionLevel)) person.levels.push(entry.permissionLevel);
    const role = roleForLevel(entry.permissionLevel);
    if (role && (!person.best || rank(role) < rank(person.best.role))) {
      person.best = { email, level: entry.permissionLevel, role };
    }
  }

  const people: PlannedPerson[] = [];
  for (const [email, person] of byEmail) {
    // Someone still invited is listed as an invitation, never given a role.
    if (invited.has(email)) continue;
    if (person.best) people.push(person.best);
    else {
      capped(report.notApplied, {
        email,
        level: person.levels.join(', '),
        message: unappliedMessage(person.levels),
      });
    }
  }

  const groupSeen = new Set<string>();
  const group = (
    g: { groupId?: string | null; name?: string | null; permissionLevel: string },
    scope: 'base' | 'workspace' | 'interface'
  ) => {
    const name = g.name?.trim() || g.groupId || 'Unnamed group';
    const key = `${scope}:${g.groupId ?? name}`;
    if (groupSeen.has(key)) return;
    groupSeen.add(key);
    capped(report.groups, { name, level: g.permissionLevel, scope });
  };
  for (const g of source.groupCollaborators?.baseCollaborators ?? []) group(g, 'base');
  for (const g of source.groupCollaborators?.workspaceCollaborators ?? []) group(g, 'workspace');

  // Interfaces (only if Airtable sent them, which they aren't asked for): listed.
  const interfaceSeen = new Set<string>();
  for (const [id, page] of Object.entries(source.interfaces ?? {})) {
    const name = page.name?.trim() || id;
    for (const person of page.individualCollaborators ?? []) {
      const email = normEmail(person.email);
      if (!email || byEmail.has(email) || invited.has(email)) continue;
      const key = `${email}\n${name}`;
      if (interfaceSeen.has(key)) continue;
      interfaceSeen.add(key);
      capped(report.interfaceOnly, { email, level: person.permissionLevel, interface: name });
    }
    for (const g of page.groupCollaborators ?? []) group(g, 'interface');
  }
  return { people, report };
}

export interface Decisions {
  raise: { person: PlannedPerson; member: BaseCollaborator }[];
  unchanged: number;
  notMembers: PlannedPerson[];
}

/**
 * Who gets a base role: workspace members (by lower-cased email) whose access to the base is
 * strictly lower than their planned role. Workspace owners and `importerId` are never changed.
 * Someone with no workspace role (a base-only collaborator) counts as not a member.
 */
export function decideRaises(
  people: readonly PlannedPerson[],
  members: readonly BaseCollaborator[],
  importerId: string
): Decisions {
  const byEmail = new Map<string, BaseCollaborator>();
  for (const m of members) {
    const email = normEmail(m.email);
    if (email && m.workspaceRole && !byEmail.has(email)) byEmail.set(email, m);
  }
  const out: Decisions = { raise: [], unchanged: 0, notMembers: [] };
  for (const person of people) {
    const member = byEmail.get(person.email);
    if (!member?.workspaceRole) {
      out.notMembers.push(person);
      continue;
    }
    const current = higherRole(member.workspaceRole, member.baseRole);
    if (
      member.userId === importerId ||
      member.workspaceRole === 'owner' ||
      !current ||
      rank(person.role) >= rank(current)
    ) {
      out.unchanged++;
      continue;
    }
    out.raise.push({ person, member });
  }
  return out;
}

export interface ApplyContext {
  tx: Transaction;
  workspaceId: string;
  baseId: string;
  /** Who ran the import: left as they are, and the audit log's actor. */
  userId: string;
  entitlements: Entitlements;
  audit?: AuditSink | undefined;
}

/**
 * Gives the planned roles in `ctx.tx` and returns the report. Each role is given in a savepoint:
 * one refused (the plan's editor seats, the base's collaborator cap) is listed, the rest go on.
 */
export async function applyCollaborators(
  ctx: ApplyContext,
  plan: CollaboratorPlan
): Promise<AirtableCollaboratorsReport> {
  const report: AirtableCollaboratorsReport = structuredClone(plan.report);
  const scope = { tx: ctx.tx, workspaceId: ctx.workspaceId, baseId: ctx.baseId };
  const members = await listBaseCollaborators(scope);
  const decided = decideRaises(plan.people, members, ctx.userId);
  report.unchanged = decided.unchanged;
  for (const p of decided.notMembers) capped(report.notMembers, { email: p.email, level: p.level });
  const importer = members.find((m) => m.userId === ctx.userId);
  for (const { person, member } of decided.raise) {
    const done = await attempt(ctx.tx, async (sp) => {
      await assertEditorRoom(
        sp,
        ctx.entitlements,
        ctx.workspaceId,
        { userId: member.userId },
        person.role
      );
      await setBaseRole({ ...scope, tx: sp }, member.userId, person.role);
      if (ctx.audit) {
        await recordAudit(ctx.audit, sp, {
          workspaceId: ctx.workspaceId,
          action: 'base_collaborator.add',
          actor: { kind: 'user', userId: ctx.userId, email: importer?.email ?? null },
          target: { type: 'base', id: ctx.baseId },
          summary: {
            after: { userId: member.userId, role: person.role, source: 'airtable_import' },
          },
        });
      }
    });
    if (done.ok) {
      capped(report.raised, {
        email: person.email,
        name: member.name,
        level: person.level,
        role: person.role,
        previous: higherRole(member.workspaceRole, member.baseRole) ?? 'read_only',
      });
    } else {
      capped(report.notApplied, {
        email: person.email,
        level: person.level,
        message: `Not given the ${person.role.replace('_', '-')} role: ${done.message}`,
      });
    }
  }
  return report;
}

/** Reads the Airtable base's collaborators: a plan, or why there is none (for the report). */
export async function readCollaborators(
  airtable: AirtableClient,
  airtableBaseId: string
): Promise<{ plan: CollaboratorPlan } | { unavailable: string; err?: unknown }> {
  try {
    const read = await airtable.collaborators(airtableBaseId);
    if (read.status === 'forbidden') return { unavailable: COLLABORATORS_FORBIDDEN };
    return { plan: planCollaborators(read.collaborators) };
  } catch (err) {
    const detail =
      err instanceof AppError && err.detail
        ? err.detail
        : 'Airtable sent an unexpected answer or none.';
    return { unavailable: collaboratorsUnreadable(detail), err };
  }
}
