import { describe, expect, it } from 'vitest';
import { planView, type ViewField } from './views.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const NAME: ViewField = { id: id(1), name: 'Name', type: 'singleLineText', isPrimary: true };
const NOTES: ViewField = { id: id(2), name: 'Notes', type: 'longText', isPrimary: false };
const STATUS: ViewField = { id: id(3), name: 'Status', type: 'singleSelect', isPrimary: false };
const OWNER: ViewField = {
  id: id(4),
  name: 'Owner',
  type: 'user',
  isPrimary: false,
  options: { multiple: false },
};
const TEAM: ViewField = {
  id: id(5),
  name: 'Team',
  type: 'user',
  isPrimary: false,
  options: { multiple: true },
};
const CREATED: ViewField = { id: id(6), name: 'Created', type: 'createdTime', isPrimary: false };
const DUE: ViewField = { id: id(7), name: 'Due', type: 'date', isPrimary: false };
const KICKOFF: ViewField = { id: id(8), name: 'Kickoff', type: 'dateTime', isPrimary: false };
const FILES: ViewField = { id: id(9), name: 'Files', type: 'attachment', isPrimary: false };

const ids = new Map([
  ['fldName0000000000', NAME.id],
  ['fldNotes000000000', NOTES.id],
  ['fldStatus00000000', STATUS.id],
]);

describe('Airtable views', () => {
  it('keeps a grid view’s visible fields in order and hides the rest', () => {
    const plan = planView(
      { type: 'grid', visibleFieldIds: ['fldStatus00000000', 'fldName0000000000', 'fldGone'] },
      [NAME, NOTES, STATUS],
      ids
    );
    expect(plan).toEqual({
      ok: true,
      type: 'grid',
      config: { grid: { fieldOrder: [STATUS.id, NAME.id], hiddenFields: [NOTES.id] } },
      note: expect.stringContaining("doesn't share its filters, sorts, groups"),
    });
  });

  it('shows every field of a grid view whose visible fields Airtable didn’t list', () => {
    const plan = planView({ type: 'grid' }, [NAME, NOTES], ids);
    expect(plan).toMatchObject({ ok: true, type: 'grid', config: {} });
    expect(plan.ok && plan.note).toContain("didn't list its visible fields");
  });

  it('stacks a kanban view by the first single select, else a one-person user field', () => {
    const bySelect = planView({ type: 'kanban' }, [NAME, OWNER, STATUS], ids);
    expect(bySelect).toMatchObject({ ok: true, config: { kanban: { stackFieldId: STATUS.id } } });
    expect(bySelect.ok && bySelect.note).toContain(
      `Stacked by "Status", the table's first single select: Airtable's API doesn't say which field it stacks by`
    );
    expect(planView({ type: 'kanban' }, [NAME, TEAM, OWNER], ids)).toMatchObject({
      ok: true,
      config: { kanban: { stackFieldId: OWNER.id } },
    });
    expect(planView({ type: 'kanban' }, [NAME, TEAM], ids)).toEqual({
      ok: false,
      message: 'There is no single select or one-person user field to stack the cards by.',
    });
  });

  it('places a calendar by the first date field people fill in, else any date', () => {
    const plan = planView({ type: 'calendar' }, [NAME, CREATED, KICKOFF, DUE], ids);
    expect(plan).toMatchObject({
      ok: true,
      type: 'calendar',
      config: { calendar: { dateFields: [{ startFieldId: KICKOFF.id, endFieldId: null }] } },
    });
    expect(plan.ok && plan.note).toContain(`Records placed by "Kickoff"`);
    expect(planView({ type: 'calendar' }, [NAME, CREATED], ids)).toMatchObject({
      config: { calendar: { dateFields: [{ startFieldId: CREATED.id }] } },
    });
    expect(planView({ type: 'calendar' }, [NAME, NOTES], ids)).toEqual({
      ok: false,
      message: 'There is no date field to place the records by.',
    });
  });

  it('starts timeline bars on the first date field', () => {
    const plan = planView({ type: 'timeline' }, [NAME, DUE, KICKOFF], ids);
    expect(plan).toMatchObject({
      ok: true,
      type: 'timeline',
      config: { timeline: { startFieldId: DUE.id, endFieldId: null } },
    });
    expect(plan.ok && plan.note).toContain('last a day');
    expect(planView({ type: 'timeline' }, [NAME], ids)).toMatchObject({ ok: false });
  });

  it('covers a gallery with the first attachment field, if there is one', () => {
    const plan = planView({ type: 'gallery' }, [NAME, FILES], ids);
    expect(plan).toMatchObject({
      ok: true,
      type: 'gallery',
      config: { gallery: { coverFieldId: FILES.id } },
    });
    expect(plan.ok && plan.note).toContain('Covered by "Files"');
    const bare = planView({ type: 'gallery' }, [NAME], ids);
    expect(bare).toMatchObject({ ok: true, config: { gallery: { coverFieldId: null } } });
    expect(bare.ok && bare.note).toContain('Without a cover');
  });

  it('creates a list view as a new one', () => {
    expect(planView({ type: 'list' }, [NAME], ids)).toMatchObject({
      ok: true,
      type: 'list',
      config: {},
    });
  });

  it("says why forms, block views and unknown types aren't imported", () => {
    expect(planView({ type: 'form' }, [NAME], ids)).toEqual({
      ok: false,
      message: expect.stringContaining("doesn't share a form's questions"),
    });
    expect(planView({ type: 'block' }, [NAME], ids)).toEqual({
      ok: false,
      message: expect.stringContaining('Gantt'),
    });
    expect(planView({ type: 'mystery' }, [NAME], ids)).toEqual({
      ok: false,
      message: "Airtable's API doesn't describe mystery views: create it again here.",
    });
  });
});
