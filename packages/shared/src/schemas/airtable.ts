import { z } from 'zod';
import { USER_ROLES } from '../constants/index.js';
import { BaseRoleSchema } from './base.js';

/**
 * The Airtable importer: a workspace creator pastes an Airtable personal access token
 * (scopes `data.records:read` and `schema.bases:read`, and optionally
 * `data.recordComments:read` for record comments), picks bases, and each becomes a new base
 * filled by a background job: tables, fields (a type mapping, formulas translated where our
 * parser takes them), then the records. The token is only kept, encrypted, for the job; it is
 * never returned. adds linked records (a second pass once every table's records are in),
 * lookups, rollups and counts on them, attachments copied from Airtable's file hosts, the views
 * Airtable's API describes well enough to build (grid, kanban, calendar, gallery, timeline,
 * list), record comments (a last pass, one request per record), cancelling and the progress the
 * dialog shows. At the end, Airtable's base collaborators are matched to workspace members by
 * email: a member whose access here is lower gets a base role (never an invitation or email);
 * everyone else is only reported. With the optional `workspacesAndBases.shares:manage` scope,
 * Airtable's share links are listed in the report too, never recreated.
 */

/** Most bases one request imports. */
export const MAX_AIRTABLE_BASES_PER_IMPORT = 10;
/** Most report lines of each kind a job keeps. */
export const MAX_AIRTABLE_REPORT_ITEMS = 500;
/** Most records an import takes from one table; the rest are left out (and reported). */
export const MAX_AIRTABLE_TABLE_RECORDS = 100_000;
/** The largest file an import copies from Airtable (Airtable's own cap is 5 GB). */
export const MAX_AIRTABLE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** An Airtable personal access token: `pat` then letters, digits and a dot. */
export const airtableTokenSchema = z
  .string()
  .trim()
  .min(20)
  .max(256)
  .regex(/^pat[A-Za-z0-9]+\.[A-Za-z0-9]+$/, 'Paste an Airtable personal access token (pat…).');

export const airtableBaseIdSchema = z.string().regex(/^app[A-Za-z0-9]{14}$/, 'Not a base id.');

/** `POST /api/workspaces/:workspaceId/airtable/bases`: the bases a token can read. */
export const listAirtableBasesSchema = z.object({ token: airtableTokenSchema }).strict();
export type ListAirtableBasesInput = z.infer<typeof listAirtableBasesSchema>;

export const AirtableBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  permissionLevel: z.string(),
});
export type AirtableBase = z.infer<typeof AirtableBaseSchema>;

export const AirtableBaseListSchema = z.object({ bases: z.array(AirtableBaseSchema) });
export type AirtableBaseList = z.infer<typeof AirtableBaseListSchema>;

/** `POST /api/workspaces/:workspaceId/airtable/imports`: one new base per Airtable base. */
export const createAirtableImportSchema = z
  .object({
    token: airtableTokenSchema,
    baseIds: z
      .array(airtableBaseIdSchema)
      .min(1)
      .max(MAX_AIRTABLE_BASES_PER_IMPORT)
      .refine((ids) => new Set(ids).size === ids.length, 'Each base can be picked once.'),
  })
  .strict();
export type CreateAirtableImportInput = z.infer<typeof createAirtableImportSchema>;

/** A field the import changed on the way: another type, or left out. */
export const AirtableReportFieldSchema = z.object({
  table: z.string(),
  field: z.string(),
  /** Airtable's field type. */
  type: z.string(),
  message: z.string(),
});
export type AirtableReportField = z.infer<typeof AirtableReportFieldSchema>;

/** A view the import left out, or created without some of its settings. */
export const AirtableReportViewSchema = z.object({
  table: z.string(),
  view: z.string(),
  /** Airtable's view type. */
  type: z.string(),
  message: z.string(),
});
export type AirtableReportView = z.infer<typeof AirtableReportViewSchema>;

/** What the comments pass did: counts, and why some of it couldn't come over. */
export const AirtableCommentsReportSchema = z.object({
  /** Comments imported. */
  imported: z.int().min(0),
  /** Of those, threaded replies: they are in the record's thread in time order. */
  replies: z.int().min(0),
  /** Reactions imported. */
  reactions: z.int().min(0),
  /**
   * Why comments weren't read (the token lacks `data.recordComments:read`, …), once for the
   * base; null when they were.
   */
  unavailable: z.string().nullable(),
  /** Airtable authors who aren't workspace members (name and email), each once. */
  unmatchedAuthors: z.array(z.string()),
  /** Comments by those authors: no author here, the body starts with their name. */
  unmatchedAuthorComments: z.int().min(0),
  /** Mentions kept as plain names: people who aren't members, user groups, app agents. */
  plainMentions: z.int().min(0),
  /** Reactions with an emoji OpenRows doesn't have. */
  otherReactions: z.int().min(0),
  /** Reactions by people who aren't workspace members. */
  unmatchedReactions: z.int().min(0),
  /** Files attached to comments: not copied (comments here have no files). */
  attachments: z.array(z.object({ table: z.string(), filename: z.string() })),
  /** Comments without text (once sanitized, or only files): left out. */
  emptyComments: z.int().min(0),
  /** Comments longer than a comment holds here: cut short. */
  truncatedComments: z.int().min(0),
  /** Records with more comments than a record holds (1,000): the oldest were left out. */
  cappedRecords: z.int().min(0),
  /** Records whose comments Airtable didn't return (the record was gone, an error, …). */
  unreadRecords: z.int().min(0),
});
export type AirtableCommentsReport = z.infer<typeof AirtableCommentsReportSchema>;

export const emptyAirtableCommentsReport = (): AirtableCommentsReport => ({
  imported: 0,
  replies: 0,
  reactions: 0,
  unavailable: null,
  unmatchedAuthors: [],
  unmatchedAuthorComments: 0,
  plainMentions: 0,
  otherReactions: 0,
  unmatchedReactions: 0,
  attachments: [],
  emptyComments: 0,
  truncatedComments: 0,
  cappedRecords: 0,
  unreadRecords: 0,
});

/**
 * The base role an Airtable permission level becomes on the imported base. Airtable's base
 * owners become creators: OpenRows has no base-level owner, and an import never makes anyone a
 * workspace owner. Other levels (`none`, interface-only access, …) aren't applied.
 */
export const AIRTABLE_LEVEL_ROLES = {
  owner: 'creator',
  create: 'creator',
  edit: 'editor',
  comment: 'commenter',
  read: 'read_only',
} as const satisfies Record<string, z.infer<typeof BaseRoleSchema>>;

const airtablePersonLine = z.object({
  email: z.string(),
  /** Airtable's permission level (`create`, `edit`, …). */
  level: z.string(),
});

/**
 * What the import did with the Airtable base's collaborators (Airtable's "Get base
 * collaborators", read once at the end of a successful import). Only workspace members already
 * in the workspace are ever given a base role, at most creator, without emails or notifications;
 * everyone else is only listed. Nobody is invited.
 */
export const AirtableCollaboratorsReportSchema = z.object({
  /** Why Airtable's collaborators couldn't be read, once; null when they were. */
  unavailable: z.string().nullable(),
  /** Workspace members given a base role on the new base: their access was lower. */
  raised: z.array(
    airtablePersonLine.extend({
      name: z.string().nullable(),
      /** The base role given. */
      role: BaseRoleSchema,
      /** Their access to the base before (their workspace role). */
      previous: z.enum([...USER_ROLES]),
    })
  ),
  /**
   * Workspace members left as they were: their access already matched or beat the Airtable level
   * (workspace owners, and the person who ran the import, always).
   */
  unchanged: z.int().min(0),
  /** People who aren't workspace members: listed only, nobody was invited or added. */
  notMembers: z.array(airtablePersonLine),
  /**
   * People whose level wasn't applied, and why: a level with no base role here (`none`,
   * interface-only access, …), no email, or a role that couldn't be given.
   */
  notApplied: z.array(airtablePersonLine.extend({ message: z.string() })),
  /** Airtable's user groups (OpenRows has none): listed only. */
  groups: z.array(
    z.object({
      name: z.string(),
      level: z.string(),
      /** Where the group had access in Airtable. */
      scope: z.enum(['base', 'workspace', 'interface']),
    })
  ),
  /** Invitations still open in Airtable: listed only, no invitations are sent here. */
  invitations: z.array(airtablePersonLine),
  /** People with access to one of the base's interfaces only: listed only. */
  interfaceOnly: z.array(airtablePersonLine.extend({ interface: z.string() })),
});
export type AirtableCollaboratorsReport = z.infer<typeof AirtableCollaboratorsReportSchema>;

export const emptyAirtableCollaboratorsReport = (): AirtableCollaboratorsReport => ({
  unavailable: null,
  raised: [],
  unchanged: 0,
  notMembers: [],
  notApplied: [],
  groups: [],
  invitations: [],
  interfaceOnly: [],
});

/**
 * One Airtable share link (Airtable's "List shares"), as the report lists it. Only described:
 * nothing is created here, and Airtable's `shareId` is never an OpenRows token.
 */
export const AirtableShareLineSchema = z.object({
  /** Airtable's share id, to find the link in Airtable. */
  shareId: z.string(),
  /** `base`, `view`, `blockInstallation`, or another type Airtable sends, as it sends it. */
  type: z.string(),
  /** `enabled` or `disabled`, as Airtable reported it. */
  state: z.string(),
  /** Airtable's view id, for a link to a view. */
  airtableViewId: z.string().nullable(),
  /** The imported view a view link was to; null when it isn't a view link or wasn't imported. */
  view: z
    .object({ tableId: z.uuid(), table: z.string(), viewId: z.uuid(), name: z.string() })
    .nullable(),
  blockInstallationId: z.string().nullable(),
  isPasswordProtected: z.boolean(),
  restrictedToEmailDomains: z.array(z.string()),
  /**
   * The domains that can open it once every restriction applies; null when Airtable sent none
   * (no domain restriction). Empty: nobody can open it.
   */
  effectiveEmailDomainAllowList: z.array(z.string()).nullable(),
  restrictedToEnterpriseMembers: z.boolean(),
  canBeSynced: z.boolean().nullable(),
  createdTime: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  /** Their email, when Airtable's collaborators answer named them. */
  createdByEmail: z.string().nullable(),
  /** What it linked to here, and what to do to have one again. */
  message: z.string(),
});
export type AirtableShareLine = z.infer<typeof AirtableShareLineSchema>;

/**
 * Airtable's share links (Airtable's "List shares", the optional
 * `workspacesAndBases.shares:manage` scope, read once at the end of a successful import). Report
 * only: no share link, form link or embed is created or published, nothing is changed in
 * Airtable.
 */
export const AirtableSharesReportSchema = z.object({
  /** Why Airtable's share links weren't listed, once; null when they were. */
  unavailable: z.string().nullable(),
  /** Why none were recreated. */
  note: z.string(),
  total: z.int().min(0),
  enabled: z.int().min(0),
  disabled: z.int().min(0),
  byType: z.object({
    base: z.int().min(0),
    view: z.int().min(0),
    blockInstallation: z.int().min(0),
    other: z.int().min(0),
  }),
  /** View links whose view was imported (the line names it). */
  viewsImported: z.int().min(0),
  /** View links whose view wasn't imported (a form, a view left out, an unknown id). */
  viewsNotImported: z.int().min(0),
  /** Entries in Airtable's answer that couldn't be read: left out. */
  unreadable: z.int().min(0),
  /** Each link, up to MAX_AIRTABLE_REPORT_ITEMS. */
  shares: z.array(AirtableShareLineSchema),
});
export type AirtableSharesReport = z.infer<typeof AirtableSharesReportSchema>;

export const AirtableReportSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      tableId: z.uuid(),
      fields: z.int().min(0),
      records: z.int().min(0),
    })
  ),
  /** Fields left out (types OpenRows doesn't have, a link to a table left out, …). */
  unsupportedFields: z.array(AirtableReportFieldSchema),
  /** Formulas our parser didn't take: kept as text with their values, the formula described. */
  untranslatedFormulas: z.array(AirtableReportFieldSchema.extend({ formula: z.string() })),
  /** Fields imported as another type, to keep their values (created time, autonumber, …). */
  converted: z.array(AirtableReportFieldSchema),
  /** Cells whose value didn't fit their field (a collaborator who isn't a member, …). */
  skippedCells: z.int().min(0),
  /** Tables with more than MAX_AIRTABLE_TABLE_RECORDS records: the rest were left out. */
  truncatedTables: z.array(z.string()),
  /** Files that couldn't be copied from Airtable: the cell keeps the others. */
  failedAttachments: z
    .array(
      z.object({
        table: z.string(),
        field: z.string(),
        filename: z.string(),
        message: z.string(),
      })
    )
    .default([]),
  /** Links to records that weren't imported, or past a cell's 1,000 links. */
  skippedLinks: z.int().min(0).default(0),
  /** Views created. */
  views: z.int().min(0).default(0),
  /** Views that weren't (a form, a calendar without a date field, …), and why. */
  unsupportedViews: z.array(AirtableReportViewSchema).default([]),
  /**
   * Views that were created without some of their settings: what Airtable's API doesn't
   * share (filters, sorts, groups, …) and the fields chosen here in their place.
   */
  partialViews: z.array(AirtableReportViewSchema).default([]),
  /** Record comments (reports stored before comments were imported have none). */
  comments: AirtableCommentsReportSchema.default(emptyAirtableCommentsReport),
  /**
   * Collaborators and roles: null until the import ends (and in reports stored before
   * collaborators were read).
   */
  collaborators: AirtableCollaboratorsReportSchema.nullable().default(null),
  /**
   * Airtable's share links, listed only: null until the import ends (and in reports stored
   * before share links were listed).
   */
  shares: AirtableSharesReportSchema.nullable().default(null),
});
export type AirtableReport = z.infer<typeof AirtableReportSchema>;

/** One base's import, as the person who started it sees it. */
export const AirtableImportSchema = z.object({
  id: z.uuid(),
  /** The new base (it fills up while the import runs). */
  baseId: z.uuid(),
  airtableBaseId: z.string(),
  name: z.string(),
  status: z.enum(['running', 'done', 'failed', 'cancelled']),
  /**
   * `schema` while the tables, fields and views are created, `records` (with their files),
   * `links` while linked records are filled in, then `comments` while record comments are read.
   */
  phase: z.enum(['schema', 'records', 'links', 'comments']),
  tables: z.int().min(0),
  tablesDone: z.int().min(0),
  records: z.int().min(0),
  /** Files copied from Airtable, and those that failed (listed in the report). */
  attachments: z.int().min(0),
  attachmentsFailed: z.int().min(0),
  /** Records whose links were written, in the links phase. */
  linkedRecords: z.int().min(0),
  /** Records whose comments were read, and comments imported, in the comments phase. */
  commentRecords: z.int().min(0),
  comments: z.int().min(0),
  /** An estimate, 0 to 100 (100 once done). */
  percent: z.int().min(0).max(100),
  report: AirtableReportSchema,
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type AirtableImport = z.infer<typeof AirtableImportSchema>;

export const AirtableImportListSchema = z.object({ imports: z.array(AirtableImportSchema) });
export type AirtableImportList = z.infer<typeof AirtableImportListSchema>;
