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

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
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
    r.skippedLinks > 0
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
