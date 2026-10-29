import type { ViewType } from '../constants/index.js';
import { CHOICE_COLORS, type ChoiceColor, nextChoiceColor } from '../fields/choices.js';
import type { RollupFunction } from '../fields/computed.js';
import type { FieldTypeName } from '../fields/index.js';
import {
  TEMPLATE_FORMAT,
  TEMPLATE_VERSION,
  type Template,
  type TemplateAutomation,
  type TemplateInterface,
  TemplateSchema,
} from './format.js';

/**
 * The authoring form of a built-in template: tables, fields, views and records named by
 * short keys instead of ids. `defineTemplate` turns it into the template format with ids derived
 * from the template's slug and the keys, so a template's document is the same on every build.
 */

type Choices = readonly (string | readonly [string, ChoiceColor])[];

export type FieldSpec = {
  key: string;
  name: string;
  description?: string;
} & (
  | {
      type: Exclude<
        FieldTypeName,
        'singleSelect' | 'multipleSelect' | 'link' | 'lookup' | 'rollup' | 'count' | 'formula'
      >;
      options?: Record<string, unknown>;
    }
  | { type: 'singleSelect' | 'multipleSelect'; choices: Choices }
  /** A link to `table` (by key), with its field there (`inverse`: key and name). */
  | {
      type: 'link';
      table: string;
      inverse?: { key: string; name: string };
      single?: boolean;
    }
  /** Lookups, rollups and counts read through `link` (a link field's key of the same table). */
  | { type: 'lookup'; link: string; field: string }
  | {
      type: 'rollup';
      link: string;
      field: string;
      fn: RollupFunction;
      precision?: number;
    }
  | { type: 'count'; link: string }
  /** The formula as written, fields by name (`{Due date}`); the install stores it by id. */
  | { type: 'formula'; formula: string; precision?: number }
);

export interface ViewSpec {
  name: string;
  type: ViewType;
  sorts?: readonly (readonly [string, 'asc' | 'desc'])[];
  groupBy?: readonly string[];
  hidden?: readonly string[];
  /** Kanban: the single select it stacks by. */
  stack?: string;
  /** Calendar and timeline: the start date field and, optionally, the end. */
  start?: string;
  end?: string;
  /** Gallery: the fields shown on cards. */
  cardFields?: readonly string[];
}

/** A record's cells by field key; link cells name linked records by their primary value. */
export type RecordSpec = Record<string, unknown>;

export interface TableSpec {
  key: string;
  name: string;
  description?: string;
  /** The first field is the primary field. */
  fields: readonly FieldSpec[];
  views?: readonly ViewSpec[];
  records?: readonly RecordSpec[];
}

export interface TemplateSpec {
  slug: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  color?: string;
  tables: readonly TableSpec[];
  /** Automations by key: `ids` gives a table's, field's or choice's id by key. */
  automations?: (ids: TemplateIds) => TemplateAutomation[];
  /** Interfaces, their page configs naming tables and fields through `ids`. */
  interfaces?: (ids: TemplateIds) => TemplateInterface[];
}

export interface TemplateIds {
  table(key: string): string;
  field(table: string, key: string): string;
}

/** A UUID (version 8, RFC 9562's custom one) from a string, the same on every run. */
export function stableUuid(input: string): string {
  // Four 32-bit FNV-1a variants over the string: no crypto in the browser build, and none needed.
  const words = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b].map((seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= h >>> 13;
    }
    return h >>> 0;
  });
  const hex = words.map((w) => w.toString(16).padStart(8, '0')).join('');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40) || 'choice';

function choiceList(choices: Choices) {
  return choices.map((c, i) => {
    const [name, color] = typeof c === 'string' ? [c, nextChoiceColor(i)] : c;
    if (!CHOICE_COLORS.includes(color)) throw new Error(`template: bad color ${color}`);
    return { id: `sel${String(i).padStart(3, '0')}${slugOf(name)}`.slice(0, 64), name, color };
  });
}

/** A built-in template in the template format (validated: a bad spec throws at build time). */
export function defineTemplate(spec: TemplateSpec): Template {
  const id = (...parts: string[]) => stableUuid(`${spec.slug}/${parts.join('/')}`);
  const tableKeys = new Set(spec.tables.map((t) => t.key));
  const ids: TemplateIds = {
    table: (key) => {
      if (!tableKeys.has(key)) throw new Error(`template ${spec.slug}: no table ${key}`);
      return id('t', key);
    },
    field: (table, key) => {
      const t = spec.tables.find((x) => x.key === table);
      const inverse = spec.tables.some((x) =>
        x.fields.some((f) => f.type === 'link' && f.table === table && f.inverse?.key === key)
      );
      if (!t || (!t.fields.some((f) => f.key === key) && !inverse)) {
        throw new Error(`template ${spec.slug}: no field ${table}.${key}`);
      }
      return id('f', table, key);
    },
  };

  // Inverse link fields go at the end of the linked table, as the field editor adds them.
  type Built = {
    key: string;
    name: string;
    description: string | null;
    type: string;
    options: Record<string, unknown>;
  };
  const fieldsOf = new Map<string, Built[]>(spec.tables.map((t) => [t.key, []]));
  const fieldOf = (table: string, key: string) =>
    fieldsOf.get(table)?.find((f) => f.key === key) ?? null;
  for (const t of spec.tables) {
    for (const f of t.fields) {
      const built: Built = {
        key: f.key,
        name: f.name,
        description: f.description ?? null,
        type: f.type,
        options: {},
      };
      switch (f.type) {
        case 'singleSelect':
        case 'multipleSelect':
          built.options = { choices: choiceList(f.choices) };
          break;
        case 'link': {
          const self = f.table === t.key;
          built.options = {
            linkedTableId: ids.table(f.table),
            inverseLinkFieldId: self || !f.inverse ? null : id('f', f.table, f.inverse.key),
            prefersSingleRecordLink: f.single ?? false,
          };
          break;
        }
        case 'lookup':
        case 'rollup':
        case 'count':
          built.options = { recordLinkFieldId: ids.field(t.key, f.link) };
          break;
        case 'formula':
          built.options = {
            formula: f.formula,
            ...(f.precision !== undefined ? { precision: f.precision } : {}),
          };
          break;
        default:
          built.options = { ...(f.options ?? {}) };
      }
      fieldsOf.get(t.key)?.push(built);
    }
  }
  for (const t of spec.tables) {
    for (const f of t.fields) {
      if (f.type !== 'link' || f.table === t.key || !f.inverse) continue;
      const target = fieldsOf.get(f.table);
      if (!target) throw new Error(`template ${spec.slug}: no table ${f.table}`);
      target.push({
        key: f.inverse.key,
        name: f.inverse.name,
        description: null,
        type: 'link',
        options: {
          linkedTableId: ids.table(t.key),
          inverseLinkFieldId: id('f', t.key, f.key),
          prefersSingleRecordLink: false,
        },
      });
    }
  }
  /** The table a link field (`key`, of `table`, either side of the link) links to. */
  const linkedTable = (table: string, key: string): string => {
    const own = spec.tables.find((x) => x.key === table)?.fields.find((f) => f.key === key);
    if (own?.type === 'link') return own.table;
    const other = spec.tables.find((x) =>
      x.fields.some((f) => f.type === 'link' && f.table === table && f.inverse?.key === key)
    );
    if (!other) throw new Error(`template ${spec.slug}: ${table}.${key} is not a link`);
    return other.key;
  };
  // Lookups and rollups name a field of the linked table: known once every table has its fields.
  for (const t of spec.tables) {
    for (const f of t.fields) {
      if (f.type !== 'lookup' && f.type !== 'rollup') continue;
      const linked = linkedTable(t.key, f.link);
      if (!fieldOf(linked, f.field)) {
        throw new Error(`template ${spec.slug}: no field ${linked}.${f.field}`);
      }
      const built = fieldOf(t.key, f.key);
      if (!built) continue;
      built.options['fieldIdInLinkedTable'] = id('f', linked, f.field);
      if (f.type === 'rollup') {
        built.options['function'] = f.fn;
        if (f.precision !== undefined) built.options['precision'] = f.precision;
      }
    }
  }

  const recordId = (table: string, i: number) => id('r', table, String(i));
  const primaryOf = (table: string) => spec.tables.find((t) => t.key === table)?.fields[0]?.key;

  const template = {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    icon: spec.icon ?? null,
    color: spec.color ?? null,
    tables: spec.tables.map((t) => {
      const built = fieldsOf.get(t.key) ?? [];
      const fid = (key: string) => ids.field(t.key, key);
      const views = (
        t.views?.length ? t.views : [{ name: 'Grid view', type: 'grid' as const }]
      ).map((v, i) => {
        const config: Record<string, unknown> = {};
        if (v.sorts?.length) {
          config['sorts'] = v.sorts.map(([key, direction]) => ({ fieldId: fid(key), direction }));
        }
        if (v.groupBy?.length) {
          config['groupBy'] = v.groupBy.map((key) => ({ fieldId: fid(key), direction: 'asc' }));
        }
        if (v.hidden?.length) config['grid'] = { hiddenFields: v.hidden.map(fid) };
        if (v.type === 'kanban' && v.stack) config['kanban'] = { stackFieldId: fid(v.stack) };
        if (v.type === 'calendar' && v.start) {
          config['calendar'] = {
            dateFields: [{ startFieldId: fid(v.start), endFieldId: v.end ? fid(v.end) : null }],
          };
        }
        if (v.type === 'timeline' && v.start) {
          config['timeline'] = {
            startFieldId: fid(v.start),
            endFieldId: v.end ? fid(v.end) : null,
          };
        }
        if (v.type === 'gallery' && v.cardFields) {
          config['gallery'] = { cardFields: v.cardFields.map(fid) };
        }
        return { id: id('v', t.key, String(i)), name: v.name, type: v.type, config };
      });
      const records = (t.records ?? []).map((r, i) => {
        const cells: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(r)) {
          if (value === null || value === undefined) continue;
          const f = t.fields.find((x) => x.key === key);
          if (!f) throw new Error(`template ${spec.slug}: ${t.key} has no field ${key}`);
          if (f.type === 'link') {
            const linked = spec.tables.find((x) => x.key === f.table);
            const primary = primaryOf(f.table);
            const names = Array.isArray(value) ? value : [value];
            cells[fid(key)] = names.map((n) => {
              const index = (linked?.records ?? []).findIndex((x) => primary && x[primary] === n);
              if (index < 0) throw new Error(`template ${spec.slug}: no ${f.table} record ${n}`);
              return recordId(f.table, index);
            });
          } else {
            cells[fid(key)] = value;
          }
        }
        return { id: recordId(t.key, i), cells };
      });
      return {
        id: ids.table(t.key),
        name: t.name,
        description: t.description ?? null,
        fields: built.map((f, i) => ({
          id: id('f', t.key, f.key),
          name: f.name,
          description: f.description,
          type: f.type,
          primary: i === 0,
          options: f.options,
        })),
        views,
        records,
      };
    }),
    automations: spec.automations?.(ids) ?? [],
    interfaces: spec.interfaces?.(ids) ?? [],
  };
  return TemplateSchema.parse(template);
}
