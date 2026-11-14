import type { AirtableImport, AirtableReport } from '@openrows/shared';

/** How far an import is, in words. */
export function importProgress(i: AirtableImport): string {
  if (i.status === 'cancelled') return `Cancelled after ${plural(i.records, 'record')}`;
  if (i.status === 'failed') return 'Failed';
  if (i.status === 'done') {
    return `Done: ${plural(i.tables, 'table')}, ${plural(i.records, 'record')}`;
  }
  if (i.phase === 'schema') return 'Creating tables, fields and views…';
  if (i.phase === 'links') {
    return `Linking records: ${plural(i.linkedRecords, 'record')} linked so far`;
  }
  if (i.phase === 'comments') {
    return `Importing comments: ${i.commentRecords.toLocaleString()} of ${plural(i.records, 'record')} read, ${plural(i.comments, 'comment')} so far`;
  }
  return `Importing records: ${i.tablesDone} of ${plural(i.tables, 'table')}, ${plural(i.records, 'record')} so far`;
}

/** The counts under the progress bar: tables, records, files, links. */
export function importCounts(i: AirtableImport): string[] {
  const out = [`${i.tablesDone} of ${plural(i.tables, 'table')}`, plural(i.records, 'record')];
  if (i.attachments || i.attachmentsFailed) {
    out.push(
      plural(i.attachments, 'file') +
        (i.attachmentsFailed ? ` (${i.attachmentsFailed} failed)` : '')
    );
  }
  if (i.linkedRecords) out.push(`${plural(i.linkedRecords, 'record')} linked`);
  if (i.comments) out.push(plural(i.comments, 'comment'));
  return out;
}

/**
 * About how long is left, from the time so far and the percent done; null until there is
 * enough to go on (5% and 5 seconds) or once it ended.
 */
export function eta(i: AirtableImport, now: number): string | null {
  if (i.status !== 'running' || !i.startedAt || i.percent < 5) return null;
  const spent = (now - Date.parse(i.startedAt)) / 1000;
  if (!(spent >= 5)) return null;
  const left = Math.max(0, (spent * (100 - i.percent)) / i.percent);
  if (left < 60) return 'less than a minute left';
  const minutes = Math.round(left / 60);
  if (minutes < 60) return `about ${plural(minutes, 'minute')} left`;
  return `about ${plural(Math.round(minutes / 60), 'hour')} left`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

/** The report's sections that have something in them, for the summary line. */
export function reportSummary(r: AirtableReport): string[] {
  const out: string[] = [];
  if (r.views) out.push(`${plural(r.views, 'view')} imported`);
  if (r.unsupportedFields.length)
    out.push(`${plural(r.unsupportedFields.length, 'field')} left out`);
  if (r.untranslatedFormulas.length) {
    out.push(`${plural(r.untranslatedFormulas.length, 'formula')} kept as text`);
  }
  if (r.converted.length) out.push(`${plural(r.converted.length, 'field')} changed type`);
  if (r.skippedCells) out.push(`${plural(r.skippedCells, 'cell')} skipped`);
  if (r.failedAttachments.length) {
    out.push(`${plural(r.failedAttachments.length, 'file')} not copied`);
  }
  if (r.skippedLinks) out.push(`${plural(r.skippedLinks, 'link')} skipped`);
  if (r.unsupportedViews.length) {
    out.push(`${plural(r.unsupportedViews.length, 'view')} not imported`);
  }
  if (r.truncatedTables.length) out.push(`${plural(r.truncatedTables.length, 'table')} cut short`);
  if (r.comments.imported) out.push(`${plural(r.comments.imported, 'comment')} imported`);
  if (r.comments.unavailable) {
    out.push(r.comments.imported ? 'some comments not imported' : 'comments not imported');
  }
  return out;
}

/**
 * The report's notes on comments, one sentence each: what came over differently, and what
 * didn't.
 */
export function commentNotes(r: AirtableReport): string[] {
  const c = r.comments;
  const out: string[] = [];
  if (c.unavailable) out.push(c.unavailable);
  if (c.replies) {
    out.push(
      `${plural(c.replies, 'reply', 'replies')} to comments ${c.replies === 1 ? 'is' : 'are'} in the record's thread in time order.`
    );
  }
  if (c.unmatchedAuthorComments) {
    out.push(
      `${plural(c.unmatchedAuthorComments, 'comment')} by people who aren't workspace members show "Former member" and start with the author's name: ${c.unmatchedAuthors.join(', ')}.`
    );
  }
  if (c.plainMentions) {
    out.push(
      `${plural(c.plainMentions, 'mention')} of people who aren't members, user groups or apps ${c.plainMentions === 1 ? 'is kept as a plain name' : 'are kept as plain names'}.`
    );
  }
  if (c.otherReactions) {
    out.push(
      `${plural(c.otherReactions, 'reaction')} with emoji OpenRows doesn't have ${c.otherReactions === 1 ? 'was' : 'were'} left out.`
    );
  }
  if (c.unmatchedReactions) {
    out.push(
      `${plural(c.unmatchedReactions, 'reaction')} by people who aren't members ${c.unmatchedReactions === 1 ? 'was' : 'were'} left out.`
    );
  }
  if (c.emptyComments) {
    out.push(
      `${plural(c.emptyComments, 'comment')} without text ${c.emptyComments === 1 ? 'was' : 'were'} left out.`
    );
  }
  if (c.truncatedComments) {
    out.push(
      `${plural(c.truncatedComments, 'comment')} longer than 10,000 characters ${c.truncatedComments === 1 ? 'was' : 'were'} cut short.`
    );
  }
  if (c.cappedRecords) {
    out.push(
      `${plural(c.cappedRecords, 'record')} had more than 1,000 comments: the oldest were left out.`
    );
  }
  if (c.unreadRecords) {
    out.push(`Airtable didn't return the comments of ${plural(c.unreadRecords, 'record')}.`);
  }
  if (c.attachments.length) {
    out.push(
      `Files attached to comments aren't copied: ${c.attachments.map((a) => `${a.filename} (${a.table})`).join(', ')}.`
    );
  }
  return out;
}

/** Whether the report has lines to show. */
export function hasReportLines(r: AirtableReport): boolean {
  return (
    r.unsupportedFields.length > 0 ||
    r.untranslatedFormulas.length > 0 ||
    r.converted.length > 0 ||
    r.truncatedTables.length > 0 ||
    r.failedAttachments.length > 0 ||
    r.unsupportedViews.length > 0 ||
    r.partialViews.length > 0 ||
    r.skippedLinks > 0 ||
    commentNotes(r).length > 0
  );
}

/** Whether the token looks like an Airtable personal access token (the server checks again). */
export function looksLikeToken(token: string): boolean {
  return /^pat[A-Za-z0-9]+\.[A-Za-z0-9]+$/.test(token.trim()) && token.trim().length >= 20;
}

/**
 * Imports started in this browser, watched until they end so a toast says so wherever you are
 * (`AirtableImportWatcher`). Only ids, never the token.
 */
const WATCH_KEY = 'openrows.airtableImports';
export interface Watched {
  id: string;
  workspaceId: string;
}

export function watchedImports(storage: Pick<Storage, 'getItem'> | undefined): Watched[] {
  try {
    const raw = JSON.parse(storage?.getItem(WATCH_KEY) ?? '[]') as unknown;
    return Array.isArray(raw)
      ? raw
          .filter(
            (w): w is Watched =>
              typeof w === 'object' &&
              w !== null &&
              typeof (w as Watched).id === 'string' &&
              typeof (w as Watched).workspaceId === 'string'
          )
          .slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

export function setWatchedImports(storage: Pick<Storage, 'setItem'> | undefined, list: Watched[]) {
  try {
    storage?.setItem(WATCH_KEY, JSON.stringify(list.slice(-20)));
  } catch {
    // Storage full or off: no toast later, the dialog still shows the imports.
  }
}
