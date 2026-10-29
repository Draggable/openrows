import { z } from 'zod';
import { BASE_ROLES, USER_ROLES } from '../constants/index.js';

const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

/** `POST /api/workspaces/:workspaceId/bases`. The workspace comes from the path. */
export const createBaseSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  icon: z.string().max(50).optional(),
  color: color.optional(),
});

export const updateBaseSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(2000).optional().nullable(),
  icon: z.string().max(50).optional().nullable(),
  color: color.optional().nullable(),
});

/** A base as the API returns it, with the caller's effective role on it. */
export const BaseSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  role: z.enum([...USER_ROLES]),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const BaseListSchema = z.object({ bases: z.array(BaseSchema) });

export const BaseRoleSchema = z.enum([...BASE_ROLES]);

export type CreateBaseInput = z.infer<typeof createBaseSchema>;
export type UpdateBaseInput = z.infer<typeof updateBaseSchema>;
export type Base = z.infer<typeof BaseSchema>;

/** At most this many base collaborators (`base_members` rows) per base. */
export const MAX_BASE_COLLABORATORS = 500;

/** At most this many pending invitations per base. */
export const MAX_BASE_INVITATIONS = 100;

/**
 * Someone with access to a base, as `GET /api/bases/:baseId/collaborators` lists them: the
 * workspace's members and the base's own collaborators. `role` is the effective one, the higher
 * of `workspaceRole` and `baseRole` (workspace owners are owners everywhere).
 */
export const BaseCollaboratorSchema = z.object({
  userId: z.uuid(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** Null for a base-only collaborator. */
  workspaceRole: z.enum([...USER_ROLES]).nullable(),
  /** Null when the access comes from the workspace only. */
  baseRole: BaseRoleSchema.nullable(),
  role: z.enum([...USER_ROLES]),
});

export const BaseCollaboratorListSchema = z.object({
  collaborators: z.array(BaseCollaboratorSchema),
});

/** `PATCH /api/bases/:baseId/collaborators/:userId`: sets the base role (creators and up). */
export const updateBaseCollaboratorSchema = z.object({ role: BaseRoleSchema });

/** `POST /api/bases/:baseId/invitations`: invite someone to this base only. */
export const createBaseInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  role: BaseRoleSchema.default('editor'),
});

export type BaseCollaborator = z.infer<typeof BaseCollaboratorSchema>;
export type UpdateBaseCollaboratorInput = z.infer<typeof updateBaseCollaboratorSchema>;
export type CreateBaseInvitationInput = z.input<typeof createBaseInvitationSchema>;

/** At most this many duplicates one person runs at a time. */
export const MAX_RUNNING_DUPLICATES = 3;

export const duplicateBaseSchema = z
  .object({
    /** The copy's name; "<base name> copy" by default. */
    name: z.string().trim().min(1).max(255).optional(),
    /** The workspace the copy goes to (creators and up there); the base's own by default. */
    workspaceId: z.uuid().optional(),
    /** Copy the records, their links and attachments too; only the structure otherwise. */
    withRecords: z.boolean().default(false),
  })
  .strict();
export type DuplicateBaseInput = z.infer<typeof duplicateBaseSchema>;

/**
 * A base duplicate running in the worker: `running` until the copy exists (`base`) or the
 * duplicate failed (`error`); `progress` counts the records copied so far. Only the person who
 * started it can read it.
 */
export const DuplicateJobSchema = z.object({
  id: z.uuid(),
  baseId: z.uuid(),
  workspaceId: z.uuid(),
  withRecords: z.boolean(),
  status: z.enum(['running', 'done', 'failed']),
  progress: z.object({ records: z.int().min(0), totalRecords: z.int().min(0) }),
  base: BaseSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type DuplicateJob = z.infer<typeof DuplicateJobSchema>;
