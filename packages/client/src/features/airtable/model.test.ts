import {
  type AirtableImport,
  emptyAirtableCollaboratorsReport,
  emptyAirtableCommentsReport,
} from '@openrows/shared';
import { describe, expect, it } from 'vitest';
import {
  collaboratorSections,
  commentNotes,
  EDIT_PERMISSIONS_NOTE,
  eta,
  hasReportLines,
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
  partialViews: [],
  comments: emptyAirtableCommentsReport(),
  collaborators: null,
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
  commentRecords: 0,
  comments: 0,
  percent: 0,
  report,
  error: null,
  createdAt: '2026-10-27T00:00:00Z',
  startedAt: null,
  finishedAt: null,
  ...over,
});

describe('airtable import model', () => {
  it("lists the collaborators' roles given and the people only listed", () => {
    expect(collaboratorSections(report)).toEqual([]);
    const r = {
      ...report,
      collaborators: {
        ...emptyAirtableCollaboratorsReport(),
        raised: [
          {
            email: 'ada@example.test',
            name: 'Ada',
            level: 'create',
            role: 'creator' as const,
            previous: 'editor' as const,
          },
        ],
        unchanged: 2,
        notMembers: [{ email: 'grace@example.test', level: 'owner' }],
        notApplied: [{ email: 'k@example.test', level: 'none', message: 'No access.' }],
        groups: [{ name: 'Design team', level: 'edit', scope: 'base' as const }],
        invitations: [{ email: 'new@example.test', level: 'read' }],
        interfaceOnly: [{ email: 'v@example.test', level: 'read', interface: 'Dashboard' }],
      },
    };
    expect(collaboratorSections(r)).toEqual([
      {
        title: 'Collaborators',
        lines: [
          'No invitations or emails were sent. 2 workspace members already had this access or more.',
          EDIT_PERMISSIONS_NOTE,
        ],
      },
      {
        title: 'Given a base role',
        lines: ['Ada (ada@example.test): editor → creator (Airtable: create)'],
      },
      {
        title: 'Not workspace members (not invited)',
        lines: ['grace@example.test (Airtable: owner)'],
      },
      { title: 'Roles not given', lines: ['k@example.test (Airtable: none): No access.'] },
      {
        title: 'Groups (OpenRows has none)',
        lines: ['Design team, a base group (Airtable: edit)'],
      },
      {
        title: 'Open Airtable invitations (not sent here)',
        lines: ['new@example.test (Airtable: read)'],
      },
      {
        title: "Interface-only (interfaces aren't imported)",
        lines: ['v@example.test, Dashboard (Airtable: read)'],
      },
    ]);
    expect(reportSummary(r)).toContain('1 person given a base role');
    expect(hasReportLines(r)).toBe(true);
    const unread = {
      ...report,
      collaborators: { ...emptyAirtableCollaboratorsReport(), unavailable: "Couldn't read." },
    };
    expect(collaboratorSections(unread)).toEqual([
      { title: 'Collaborators', lines: ["Couldn't read.", EDIT_PERMISSIONS_NOTE] },
    ]);
    expect(reportSummary(unread)).toContain('collaborators not read');
  });

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
    expect(
      importProgress(job({ phase: 'comments', records: 1500, commentRecords: 250, comments: 1 }))
    ).toBe('Importing comments: 250 of 1,500 records read, 1 comment so far');
  });

  it('counts tables, records, files and links', () => {
    expect(
      importCounts(
        job({ tables: 2, tablesDone: 1, records: 10, attachments: 4, attachmentsFailed: 1 })
      )
    ).toEqual(['1 of 2 tables', '10 records', '4 files (1 failed)']);
    expect(importCounts(job({ linkedRecords: 5 }))).toContain('5 records linked');
    expect(importCounts(job({ comments: 12 }))).toContain('12 comments');
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

  it('shows the report for views created without some of their settings', () => {
    expect(hasReportLines(report)).toBe(false);
    const view = { table: 'T', view: 'By status', type: 'kanban', message: 'Stacked by "Status".' };
    const partial = { ...report, views: 1, partialViews: [view] };
    expect(hasReportLines(partial)).toBe(true);
    // Notes on views that were created don't add to the summary line.
    expect(reportSummary(partial)).toEqual(['1 view imported']);
  });

  it('reports comments: what came over, what changed and what was left out', () => {
    const comments = {
      ...emptyAirtableCommentsReport(),
      imported: 12,
      replies: 2,
      unmatchedAuthors: ['Grace Hopper (grace@example.test)'],
      unmatchedAuthorComments: 3,
      plainMentions: 1,
      otherReactions: 2,
      attachments: [{ table: 'Projects', filename: 'shot.png' }],
    };
    const withComments = { ...report, comments };
    expect(reportSummary(withComments)).toEqual(['12 comments imported']);
    expect(hasReportLines(withComments)).toBe(true);
    expect(commentNotes(withComments)).toEqual([
      "2 replies to comments are in the record's thread in time order.",
      '3 comments by people who aren\'t workspace members show "Former member" and start with the author\'s name: Grace Hopper (grace@example.test).',
      "1 mention of people who aren't members, user groups or apps is kept as a plain name.",
      "2 reactions with emoji OpenRows doesn't have were left out.",
      "Files attached to comments aren't copied: shot.png (Projects).",
    ]);
    // Without the scope: once, with the reason.
    const missing = {
      ...report,
      comments: { ...emptyAirtableCommentsReport(), unavailable: 'Add data.recordComments:read.' },
    };
    expect(reportSummary(missing)).toEqual(['comments not imported']);
    expect(commentNotes(missing)).toEqual(['Add data.recordComments:read.']);
    expect(commentNotes(report)).toEqual([]);
  });

  it('recognizes personal access tokens', () => {
    expect(looksLikeToken(`patAbc123def456gh.${'a'.repeat(64)}`)).toBe(true);
    expect(looksLikeToken('keyAbc123')).toBe(false);
  });
});
