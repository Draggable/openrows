import { type CreateFieldInput, nextChoiceColor } from '@openrows/shared';

/**
 * The "Product Roadmap" demo template: 5 tables, 31 fields (each table's default Name,
 * Notes and Status plus the extras below) and 2,000 records, generated from a fixed seed so every
 * run produces the same data. Values are given the way a user would type them (choice names,
 * plain numbers, ISO dates); the RecordService coerces them like any other write.
 */

export const DEMO_WORKSPACE_NAME = 'Product Roadmap (demo)';
export const DEMO_BASE_NAME = 'Product Roadmap';

export interface TemplateTable {
  name: string;
  /** Fields added after the defaults every new table gets (Name, Notes, Status). */
  fields: CreateFieldInput[];
  records: number;
  /** Cell values by field name for record `i`; `rand` is the template's seeded generator. */
  row: (i: number, rand: Random) => Record<string, unknown>;
}

export interface Random {
  /** A float in [0, 1). */
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32: small, fast and deterministic, which is all demo data needs. */
export function random(seed: number): Random {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
  };
}

function choices(names: readonly string[]) {
  return {
    choices: names.map((name, i) => ({
      id: `sel${String(i).padStart(3, '0')}${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(
        0,
        64
      ),
      name,
      color: nextChoiceColor(i),
    })),
  };
}

/** `days` after 2026-01-05 as YYYY-MM-DD. */
function day(days: number): string {
  return new Date(Date.UTC(2026, 0, 5) + days * 86_400_000).toISOString().slice(0, 10);
}

const STATUS = ['Todo', 'In progress', 'Done'] as const;
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
const TAGS = ['Grid', 'Import', 'API', 'Mobile', 'Billing', 'Search', 'Auth'] as const;
const AREAS = ['Onboarding', 'Collaboration', 'Performance', 'Integrations', 'Reporting'] as const;
const VERBS = ['Improve', 'Add', 'Redesign', 'Speed up', 'Simplify', 'Document'] as const;
const NOUNS = [
  'CSV import',
  'record expand view',
  'sharing dialog',
  'field editor',
  'filter menu',
  'API tokens',
  'grid scrolling',
  'invite flow',
  'attachments',
  'command palette',
] as const;
const FIRST = ['Ada', 'Ben', 'Chloé', 'Dev', 'Eun', 'Femi', 'Gus', 'Hana', 'Ivo', 'Jun'] as const;
const LAST = ['Okafor', 'Lindqvist', 'Moreau', 'Patel', 'Kim', 'Novak', 'Silva', 'Haddad'] as const;
const ROLES = ['Engineer', 'Designer', 'Product manager', 'Support', 'Data analyst'] as const;
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay'] as const;

function person(i: number) {
  const first = FIRST[i % FIRST.length] ?? 'Ada';
  const last = LAST[Math.floor(i / FIRST.length) % LAST.length] ?? 'Okafor';
  return { name: `${first} ${last}`, email: `${first}.${last}${i}@example.com`.toLowerCase() };
}

export const PRODUCT_ROADMAP: readonly TemplateTable[] = [
  {
    name: 'Features',
    records: 1000,
    fields: [
      { name: 'Priority', type: 'singleSelect', options: choices(PRIORITIES) },
      { name: 'Effort', type: 'number', options: { precision: 1 } },
      { name: 'Target date', type: 'date' },
      { name: 'Tags', type: 'multipleSelect', options: choices(TAGS) },
      { name: 'Owner email', type: 'email' },
      { name: 'Spec', type: 'url' },
      { name: 'Shipped', type: 'checkbox' },
    ],
    row: (i, r) => {
      const status = r.pick(STATUS);
      return {
        Name: `${r.pick(VERBS)} ${r.pick(NOUNS)} #${i + 1}`,
        Notes: r.next() < 0.3 ? `Requested by ${r.pick(COMPANIES)}.` : null,
        Status: status,
        Priority: r.pick(PRIORITIES),
        Effort: r.int(1, 40) / 2,
        'Target date': day(r.int(0, 364)),
        Tags: [r.pick(TAGS), r.pick(TAGS)],
        'Owner email': person(r.int(0, 79)).email,
        Spec: `https://docs.example.com/specs/${i + 1}`,
        Shipped: status === 'Done',
      };
    },
  },
  {
    name: 'Epics',
    records: 200,
    fields: [
      { name: 'Progress', type: 'percent' },
      { name: 'Budget', type: 'currency', options: { currencyCode: 'USD' } },
    ],
    row: (i, r) => ({
      Name: `${r.pick(AREAS)} epic ${i + 1}`,
      Notes: null,
      Status: r.pick(STATUS),
      Progress: r.int(0, 100) / 100,
      Budget: r.int(5, 250) * 1000,
    }),
  },
  {
    name: 'Releases',
    records: 100,
    fields: [
      { name: 'Release date', type: 'date' },
      { name: 'Confidence', type: 'rating' },
    ],
    row: (i, r) => ({
      Name: `v${Math.floor(i / 10) + 1}.${i % 10}.0`,
      Notes: r.next() < 0.5 ? 'Release notes drafted.' : null,
      Status: i < 60 ? 'Done' : r.pick(STATUS),
      'Release date': day(i * 3),
      Confidence: r.int(1, 5),
    }),
  },
  {
    name: 'Customer feedback',
    records: 600,
    fields: [
      { name: 'Customer email', type: 'email' },
      { name: 'Phone', type: 'phone' },
      { name: 'Received', type: 'dateTime' },
    ],
    row: (i, r) => ({
      Name: `${r.pick(COMPANIES)}: ${r.pick(NOUNS)} feedback`,
      Notes: `Ticket ${10_000 + i}`,
      Status: r.pick(STATUS),
      'Customer email': `customer${i}@${r.pick(COMPANIES).toLowerCase()}.example`,
      Phone: `+1 555 ${String(r.int(1000, 9999))}`,
      Received: `${day(r.int(0, 300))}T${String(r.int(8, 18)).padStart(2, '0')}:30:00.000Z`,
    }),
  },
  {
    name: 'Team',
    records: 100,
    fields: [
      { name: 'Role', type: 'singleLineText' },
      // The seeding user, from the record's system column.
      { name: 'Created by', type: 'createdBy' },
    ],
    row: (i, r) => ({
      Name: person(i).name,
      Notes: null,
      Status: r.pick(STATUS),
      Role: r.pick(ROLES),
    }),
  },
];
