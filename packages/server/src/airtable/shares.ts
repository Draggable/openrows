import type { AirtableShareLine, AirtableSharesReport } from '@openrows/shared';
import { AppError } from '../lib/errors.js';
import type { AirtableClient, AirtableCollaborators, AirtableShare } from './client.js';
import { capped } from './schema.js';

/**
 * Airtable's share links in the import report, at the end of a successful import. Report only.
 *
 * Airtable's "List shares" (the optional `workspacesAndBases.shares:manage` scope) is read once
 * per base. Each share is listed with what Airtable says about it (type, state, password,
 * domain and enterprise restrictions, who made it and when) and, for a link to a view, the view
 * imported from it, if any. Nothing is recreated:
 *
 * - an OpenRows share link is public as soon as it's made (a form view's link takes submissions),
 *   and there is no disabled or draft link to make instead;
 * - Airtable's answer doesn't include a share's password, only whether it has one;
 * - Airtable's `shareId` is Airtable's own link, never an OpenRows token.
 *
 * So no share link, form link or embed is created, and nothing is enabled, disabled or deleted in
 * Airtable: the person recreates the links they want (Sharing). A 401, 403 or 404 means the token
 * can't list them: the import still succeeds and the report says so once.
 */

/** Why none were recreated (the report's note). */
export const SHARES_NOT_RECREATED =
  "No share links, form links or embeds were created: a new OpenRows link is public as soon as it's made, and Airtable's API gives neither a share's password nor a link that works here. Recreate the ones you need with Share (see Sharing).";
/** 403 or 404: the token lacks the scope, or Airtable won't let it list the base's shares. */
export const SHARES_FORBIDDEN =
  "The token can't list this base's share links (Airtable's \"List shares\" needs the optional workspacesAndBases.shares:manage scope, and Airtable has to let the token list the base's shares). Everything else was imported.";
/** 401 on the shares request. */
export const SHARES_TOKEN_REJECTED =
  "Airtable rejected the token when asked for the base's share links, so they weren't listed. Everything else was imported.";
/** Something else went wrong listing them. */
export const sharesUnreadable = (detail: string) =>
  `Airtable's share links couldn't be listed: ${detail} Everything else was imported.`;

/** One of the import's Airtable views, and what it became (`imported` null: not imported). */
export interface KnownView {
  table: string;
  /** Airtable's view type. */
  type: string;
  name: string;
  imported: { tableId: string; viewId: string; name: string } | null;
  /** True when a view was made from it but isn't in the base any more. */
  gone?: boolean;
}

const KNOWN_TYPES = ['base', 'view', 'blockInstallation'] as const;

export const emptyAirtableSharesReport = (): AirtableSharesReport => ({
  unavailable: null,
  note: SHARES_NOT_RECREATED,
  total: 0,
  enabled: 0,
  disabled: 0,
  byType: { base: 0, view: 0, blockInstallation: 0, other: 0 },
  viewsImported: 0,
  viewsNotImported: 0,
  unreadable: 0,
  shares: [],
});

/**
 * Airtable user ids → lower-cased emails from a collaborators answer the import already read
 * (no other request: Airtable has no official way to look a user up).
 */
export function airtableUserEmails(source: AirtableCollaborators | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!source) return out;
  const add = (p: { userId?: string | null; email?: string | null }) => {
    const email = p.email?.trim().toLowerCase();
    if (p.userId && email && !out.has(p.userId)) out.set(p.userId, email);
  };
  for (const scope of [source.individualCollaborators, source.collaborators]) {
    for (const p of scope?.baseCollaborators ?? []) add(p);
    for (const p of scope?.workspaceCollaborators ?? []) add(p);
  }
  for (const page of Object.values(source.interfaces ?? {})) {
    for (const p of page.individualCollaborators ?? []) add(p);
  }
  return out;
}

function viewMessage(share: AirtableShare, view: KnownView | undefined): string {
  if (!view) {
    return share.viewId
      ? `A link to a view this import didn't read (Airtable's ${share.viewId}).`
      : "A link to a view Airtable didn't name.";
  }
  const where = `"${view.name}" in ${view.table}`;
  if (view.imported) {
    return `A link to the view ${where}. Not recreated: use "Share view" on the imported view to make one.`;
  }
  if (view.gone) return `A link to the view ${where}, which has been deleted from the new base.`;
  if (view.type === 'form') {
    return `A link to the form ${where}. Form views aren't imported: build the form again (see Forms), then share it.`;
  }
  return `A link to the ${view.type} view ${where}, which wasn't imported (see "Views not imported").`;
}

function messageOf(share: AirtableShare, view: KnownView | undefined): string {
  switch (share.type) {
    case 'base':
      return 'A link to the whole base. Not recreated: share the base from its Share dialog to make one.';
    case 'view':
      return viewMessage(share, view);
    case 'blockInstallation':
      return "A link to an Airtable extension. Airtable's extensions aren't imported, so it has nothing to link to here.";
    default:
      return `A link of Airtable's "${share.type}" type: listed only.`;
  }
}

/**
 * The report of a List shares answer: every share as Airtable described it, view links mapped
 * to the views imported from them. Pure: it creates nothing.
 */
export function planShares(
  shares: readonly AirtableShare[],
  unreadable: number,
  views: ReadonlyMap<string, KnownView>,
  emails: ReadonlyMap<string, string>
): AirtableSharesReport {
  const report = emptyAirtableSharesReport();
  report.unreadable = unreadable;
  for (const share of shares) {
    report.total++;
    if (share.state === 'enabled') report.enabled++;
    else if (share.state === 'disabled') report.disabled++;
    const known = (KNOWN_TYPES as readonly string[]).includes(share.type)
      ? (share.type as (typeof KNOWN_TYPES)[number])
      : 'other';
    report.byType[known]++;
    const view = share.type === 'view' && share.viewId ? views.get(share.viewId) : undefined;
    if (share.type === 'view') {
      if (view?.imported) report.viewsImported++;
      else report.viewsNotImported++;
    }
    const line: AirtableShareLine = {
      shareId: share.shareId,
      type: share.type,
      state: share.state,
      airtableViewId: share.viewId ?? null,
      view: view?.imported
        ? {
            tableId: view.imported.tableId,
            table: view.table,
            viewId: view.imported.viewId,
            name: view.imported.name,
          }
        : null,
      blockInstallationId: share.blockInstallationId ?? null,
      isPasswordProtected: share.isPasswordProtected ?? false,
      restrictedToEmailDomains: share.restrictedToEmailDomains ?? [],
      effectiveEmailDomainAllowList: share.effectiveEmailDomainAllowList ?? null,
      restrictedToEnterpriseMembers: share.restrictedToEnterpriseMembers ?? false,
      canBeSynced: share.canBeSynced ?? null,
      createdTime: share.createdTime ?? null,
      createdByUserId: share.createdByUserId ?? null,
      createdByEmail: (share.createdByUserId && emails.get(share.createdByUserId)) || null,
      message: messageOf(share, view),
    };
    capped(report.shares, line);
  }
  return report;
}

export type SharesRead =
  | { listed: { shares: AirtableShare[]; unreadable: number } }
  | { unavailable: string; err?: unknown };

/** Lists the Airtable base's share links: the list, or why there is none (for the report). */
export async function readShares(
  airtable: AirtableClient,
  airtableBaseId: string
): Promise<SharesRead> {
  try {
    const read = await airtable.shares(airtableBaseId);
    if (read.status === 'forbidden') return { unavailable: SHARES_FORBIDDEN };
    if (read.status === 'rejected') return { unavailable: SHARES_TOKEN_REJECTED };
    return { listed: { shares: read.shares, unreadable: read.unreadable } };
  } catch (err) {
    const detail =
      err instanceof AppError && err.detail
        ? err.detail
        : 'Airtable sent an unexpected answer or none.';
    return { unavailable: sharesUnreadable(detail), err };
  }
}

/** The report for what `readShares` gave. */
export function sharesReport(
  read: SharesRead,
  views: ReadonlyMap<string, KnownView>,
  emails: ReadonlyMap<string, string>
): AirtableSharesReport {
  if ('unavailable' in read)
    return { ...emptyAirtableSharesReport(), unavailable: read.unavailable };
  return planShares(read.listed.shares, read.listed.unreadable, views, emails);
}
