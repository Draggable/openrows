import type { AirtableImport } from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  eta,
  importCounts,
  importProgress,
  looksLikeToken,
  reportSummary,
  watchedImports,
} from './model';

const report = {
  tables: [],
  unsupportedFields: [],
  untranslatedFormulas: [],
  converted: [],
  skippedCells: 0,
  truncatedTables: [],
  failedAttachments: [],
  skippedLinks: 0,
  views: 0,
  unsupportedViews: [],
};

const job = (over: Partial<AirtableImport>): AirtableImport => ({
  id: '01900000-0000-7000-8000-000000000001',
  baseId: '01900000-0000-7000-8000-000000000002',
  airtableBaseId: 'appFixtureBase001',
  name: 'Launch',
  status: 'running',
  phase: 'schema',
  tables: 0,
  tablesDone: 0,
  records: 0,
  attachments: 0,
  attachmentsFailed: 0,
  linkedRecords: 0,
  percent: 0,
  report,
  error: null,
  createdAt: '2026-10-27T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  ...over,
});

describe('airtable import model', () => {
  it('describes progress', () => {
    expect(importProgress(job({}))).toBe('Creating tables, fields and views…');
    expect(importProgress(job({ phase: 'links', linkedRecords: 1200 }))).toBe(
      'Linking records: 1,200 records linked so far'
    );
    expect(importProgress(job({ status: 'cancelled', records: 3 }))).toBe(
      'Cancelled after 3 records'
    );
    expect(importProgress(job({ phase: 'records', tables: 2, tablesDone: 1, records: 100 }))).toBe(
      'Importing records: 1 of 2 tables, 100 records so far'
    );
    expect(importProgress(job({ status: 'done', tables: 1, records: 1 }))).toBe(
      'Done: 1 table, 1 record'
    );
    expect(importProgress(job({ status: 'failed' }))).toBe('Failed');
  });

  it('counts tables, records, files and links', () => {
    expect(
      importCounts(
        job({ tables: 2, tablesDone: 1, records: 10, attachments: 4, attachmentsFailed: 1 })
      )
    ).toEqual(['1 of 2 tables', '10 records', '4 files (1 failed)']);
    expect(importCounts(job({ linkedRecords: 5 }))).toContain('5 records linked');
  });

  it('estimates the time left from the pace so far', () => {
    const at = Date.parse('2026-10-27T00:00:00Z');
    const running = job({ startedAt: '2026-10-27T00:00:00Z', percent: 25 });
    // A quarter in 2 minutes: 6 more.
    expect(eta(running, at + 120_000)).toBe('about 6 minutes left');
    expect(eta(running, at + 10_000)).toBe('less than a minute left');
    expect(eta(running, at + 2_000)).toBeNull();
    expect(eta(job({ startedAt: '2026-10-27T00:00:00Z', percent: 2 }), at + 60_000)).toBeNull();
    expect(eta({ ...running, status: 'done' }, at + 60_000)).toBeNull();
  });

  it('reads the watched imports defensively', () => {
    const w = { id: 'a', workspaceId: 'b' };
    expect(watchedImports({ getItem: () => JSON.stringify([w, { id: 1 }, 'x']) })).toEqual([w]);
    expect(watchedImports({ getItem: () => 'not json' })).toEqual([]);
    expect(watchedImports(undefined)).toEqual([]);
  });

  it('summarizes the report', () => {
    expect(reportSummary(report)).toEqual([]);
    const field = { table: 'T', field: 'F', type: 'rollup', message: 'later' };
    expect(
      reportSummary({
        ...report,
        unsupportedFields: [field, field],
        untranslatedFormulas: [{ ...field, formula: 'X()' }],
        skippedCells: 3,
        failedAttachments: [{ table: 'T', field: 'Files', filename: 'a.png', message: 'x' }],
        views: 2,
        skippedLinks: 1,
      })
    ).toEqual([
      '2 views imported',
      '2 fields left out',
      '1 formula kept as text',
      '3 cells skipped',
      '1 file not copied',
      '1 link skipped',
    ]);
  });

  it('recognizes personal access tokens', () => {
    expect(looksLikeToken(`patAbc123def456gh.${'a'.repeat(64)}`)).toBe(true);
    expect(looksLikeToken('keyAbc123')).toBe(false);
  });
});
