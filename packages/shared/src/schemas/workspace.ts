import { z } from 'zod';
import { USER_ROLES } from '../constants/index.js';
import { choiceColorSchema } from '../fields/choices.js';

/** `POST /api/workspaces`. The caller becomes the owner. */
export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(255),
});

/** `PATCH /api/workspaces/:workspaceId` (owners only). */
export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
});

/**
 * A workspace as the API returns it, with the caller's role in it. `role` is null for a base-only
 * collaborator: they were invited to some of its bases and see only those.
 */
export const WorkspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.enum([...USER_ROLES]).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const WorkspaceListSchema = z.object({ workspaces: z.array(WorkspaceSchema) });

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;

const roleSchema = z.enum([...USER_ROLES]);

/** A member of a workspace, as `GET /api/workspaces/:workspaceId/members` lists them. */
export const MemberSchema = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: roleSchema,
  joinedAt: z.iso.datetime({ offset: true }),
});

export const MemberListSchema = z.object({ members: z.array(MemberSchema) });

/** `PATCH /api/workspaces/:workspaceId/members/:userId`. Only owners may grant `owner`. */
export const updateMemberSchema = z.object({ role: roleSchema });

/** `POST /api/workspaces/:workspaceId/invitations`. Inviting a pending address again re-sends. */
export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  role: roleSchema.default('editor'),
});

/**
 * A pending invitation, as owners and creators see it. The token is only ever emailed. A base
 * invitation (`baseId` set) makes the invitee a collaborator of that base only.
 */
export const InvitationSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  baseId: z.uuid().nullable(),
  /** An interface invitation: the invitee gets this interface only, not its base. */
  interfaceId: z.uuid().nullable().default(null),
  email: z.string(),
  role: roleSchema,
  invitedByName: z.string().nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  sentAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
  /** On create and resend: whether the email went out (false when SMTP failed). */
  emailSent: z.boolean().optional(),
});

export const InvitationListSchema = z.object({ invitations: z.array(InvitationSchema) });

export const INVITATION_STATUSES = ['pending', 'expired', 'revoked', 'accepted'] as const;

/** `GET /api/invitations/:token`: what the invitee sees before accepting. */
export const InvitationPreviewSchema = z.object({
  workspaceId: z.uuid(),
  workspaceName: z.string(),
  /** A base invitation: the base the invitee joins, not the whole workspace. */
  baseId: z.uuid().nullable(),
  baseName: z.string().nullable(),
  /** An interface invitation: the interface the invitee gets, not its base. */
  interfaceId: z.uuid().nullable().default(null),
  interfaceName: z.string().nullable().default(null),
  inviterName: z.string().nullable(),
  email: z.string(),
  role: roleSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  status: z.enum(INVITATION_STATUSES),
  /** Whether the signed-in user's verified email is the invited one (accepting needs it). */
  emailMatches: z.boolean(),
  /**
   * Whether the signed-in user already has this access: a member of the workspace, or for a
   * base invitation, the invited role or a higher one on the base.
   */
  alreadyMember: z.boolean(),
});

export type Member = z.infer<typeof MemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type CreateInvitationInput = z.input<typeof createInvitationSchema>;
export type Invitation = z.infer<typeof InvitationSchema>;
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * One person of a workspace's collaborator directory, as
 * `GET /api/workspaces/:workspaceId/collaborators` lists them: workspace members and the
 * base-only collaborators of bases the caller can see. `email` is there only for callers who see
 * members' emails on the members page (workspace members); the avatar is initials on a chip
 * colour picked from the id.
 */
export const CollaboratorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string().optional(),
  initials: z.string().max(2),
  color: choiceColorSchema,
});

export const CollaboratorListSchema = z.object({ collaborators: z.array(CollaboratorSchema) });

export type Collaborator = z.infer<typeof CollaboratorSchema>;
