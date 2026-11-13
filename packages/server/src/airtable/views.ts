import {
  isCalendarDateField,
  isStackableField,
  type UpdateViewInput,
  type ViewType,
} from '@openrows/shared';
import type { AirtableView } from './client.js';

/**
 * Airtable's views → ours. Pure: the schema step plans each view from the table's fields
 * (ours, once every field exists), then creates it with `createView` and `updateView`.
 *
 * Airtable's Meta API describes a view by its id, name and type, and a grid view's visible
 * fields in their order (`include=visibleFieldIds`); nothing else. It shares no filters, sorts,
 * groups, row colours, record order, nor which field a kanban stacks by, a calendar or timeline
 * places records by, or a gallery covers with. So:
 *
 * - grid: the visible fields in Airtable's order, the rest hidden;
 * - kanban: stacked by the table's first single select (or one-person user field);
 * - calendar: placed by the table's first date field;
 * - timeline: bars from the table's first date field, a day long;
 * - gallery: covered by the table's first attachment field, if any;
 * - list: as a new list view;
 * - form and block (Gantt, extensions) views aren't imported: the API doesn't describe them.
 *
 * Every created view gets a report note saying what was chosen here and what the API left out.
 */

/** A field of the table the view is created in. */
export interface ViewField {
  id: string;
  name: string;
  type: string;
  isPrimary: boolean;
  options?: unknown;
}

export type ViewPlan =
  | { ok: true; type: ViewType; config: UpdateViewInput; note: string }
  | { ok: false; message: string };

const API = "Airtable's API";

/** The settings Airtable's API never shares, for the report. */
const notShared = (what: string) => `${API} doesn't share its ${what}.`;

const DATE_TYPES = new Set(['date', 'dateTime']);

/** The table's first date field: one people fill in, else any date (created time, …). */
function firstDate(fields: readonly ViewField[]): ViewField | undefined {
  return fields.find((f) => DATE_TYPES.has(f.type)) ?? fields.find(isCalendarDateField);
}

export function planView(
  view: Pick<AirtableView, 'type' | 'visibleFieldIds'>,
  fields: readonly ViewField[],
  ids: ReadonlyMap<string, string>
): ViewPlan {
  switch (view.type) {
    case 'grid': {
      const ours = new Set(fields.map((f) => f.id));
      const visible = [
        ...new Set(
          (view.visibleFieldIds ?? [])
            .map((id) => ids.get(id))
            .filter((id): id is string => id !== undefined && ours.has(id))
        ),
      ];
      const primaryId = fields.find((f) => f.isPrimary)?.id;
      const settings = 'filters, sorts, groups, row colours, record order or column widths';
      if (!visible.length) {
        return {
          ok: true,
          type: 'grid',
          config: {},
          note: `${API} didn't list its visible fields, so every field shows. ${notShared(settings)}`,
        };
      }
      return {
        ok: true,
        type: 'grid',
        config: {
          grid: {
            fieldOrder: visible,
            hiddenFields: fields
              .filter((f) => f.id !== primaryId && !visible.includes(f.id))
              .map((f) => f.id),
          },
        },
        note: notShared(settings),
      };
    }
    case 'kanban': {
      const stack =
        fields.find((f) => f.type === 'singleSelect') ??
        fields.find((f) => f.type === 'user' && isStackableField(f));
      if (!stack) {
        return {
          ok: false,
          message: 'There is no single select or one-person user field to stack the cards by.',
        };
      }
      const kind = stack.type === 'singleSelect' ? 'single select' : 'one-person user field';
      return {
        ok: true,
        type: 'kanban',
        config: { kanban: { stackFieldId: stack.id } },
        note: `Stacked by "${stack.name}", the table's first ${kind}: ${API} doesn't say which field it stacks by, its card fields or cover. ${notShared('filters, sorts or record order')}`,
      };
    }
    case 'calendar': {
      const date = firstDate(fields);
      if (!date) return { ok: false, message: 'There is no date field to place the records by.' };
      return {
        ok: true,
        type: 'calendar',
        config: { calendar: { dateFields: [{ startFieldId: date.id, endFieldId: null }] } },
        note: `Records placed by "${date.name}", the table's first date field: ${API} doesn't say which date fields it uses. ${notShared('filters or colours')}`,
      };
    }
    case 'timeline': {
      const date = firstDate(fields);
      if (!date) return { ok: false, message: 'There is no date field to place the bars by.' };
      return {
        ok: true,
        type: 'timeline',
        config: { timeline: { startFieldId: date.id, endFieldId: null } },
        note: `Bars start on "${date.name}", the table's first date field, and last a day: ${API} doesn't say which date fields it uses. ${notShared('filters, sorts, groups or colours')}`,
      };
    }
    case 'gallery': {
      const cover = fields.find((f) => f.type === 'attachment');
      return {
        ok: true,
        type: 'gallery',
        config: { gallery: { coverFieldId: cover?.id ?? null } },
        note: `${cover ? `Covered by "${cover.name}", the table's first attachment field` : 'Without a cover (the table has no attachment field)'}: ${API} doesn't say which fields its cards show or its cover. ${notShared('filters, sorts or record order')}`,
      };
    }
    case 'list':
      return {
        ok: true,
        type: 'list',
        config: {},
        note: `${API} doesn't say which fields it shows or how records nest. ${notShared('filters, sorts or groups')}`,
      };
    case 'form':
      return {
        ok: false,
        message: `${API} doesn't share a form's questions, labels or settings: create the form again here.`,
      };
    case 'block':
      return {
        ok: false,
        message: `${API} lists Gantt views and extensions as "block" views, without their settings: create a timeline view here for a Gantt chart.`,
      };
    default:
      return {
        ok: false,
        message: `${API} doesn't describe ${view.type} views: create it again here.`,
      };
  }
}
