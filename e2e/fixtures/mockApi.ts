import {
  BUILT_IN_TEMPLATES,
  evaluateFormula,
  fieldFormulaValue,
  findTemplate,
  formulaResult,
  getFieldType,
  hasFormula,
  isFieldTypeName,
  parseStoredFormula,
  templateSummary,
} from '@openrows/shared';
import type { BrowserContext, Page, Route } from '@playwright/test';

// An in-browser stand-in for the API (page.route), so grid specs run against the built client
// alone (the built client served by the api, or the Compose stack: requests never reach the server). Records are
// generated from their index, so a 100k-row table costs nothing to "seed"; edits are kept.

const now = '2026-10-25T10:00:00.000Z';
const stamp = { createdAt: now, updatedAt: now };
const uuid = (prefix: number, n: number) =>
  `${prefix.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

export const IDS = {
  workspace: uuid(1, 1),
  base: uuid(2, 1),
  table: uuid(3, 1),
  view: uuid(4, 1),
  /** A second grid view (`secondView`). */
  view2: uuid(4, 2),
  name: uuid(5, 1),
  notes: uuid(5, 2),
  done: uuid(5, 3),
  estimate: uuid(5, 4),
  status: uuid(5, 5),
  tags: uuid(5, 6),
  due: uuid(5, 7),
  launch: uuid(5, 8),
  score: uuid(5, 9),
  site: uuid(5, 10),
  mail: uuid(5, 11),
  phone: uuid(5, 12),
  mockups: uuid(5, 13),
  owner: uuid(5, 14),
  code: uuid(5, 15),
  open: uuid(5, 16),
  brief: uuid(5, 17),
  stage: uuid(5, 18),
  start: uuid(5, 19),
  end: uuid(5, 20),
  deps: uuid(5, 21),
  parent: uuid(5, 22),
};

/** The record `i` of the timeline mock waits for: the one before it, for i % 4 of 1 and 2. */
export const dependsOn = (i: number): number | null => (i % 4 === 1 || i % 4 === 2 ? i - 1 : null);

/** The parent of record `i` in the list mock: records 0–2 are top-level, then three each. */
export const parentOf = (i: number): number | null => (i < 3 ? null : Math.floor((i - 3) / 3));

/**
 * Where record `i` of the calendar mock sits: on March (1 + i % 28), 2026; every fourth
 * record (from the first) is a three-day range; every seventh (from the seventh) has no date.
 */
export function calendarDates(i: number): { start: string | null; end: string | null } {
  if (i % 7 === 6) return { start: null, end: null };
  const day = 1 + (i % 28);
  const iso = (d: number) => `2026-03-${String(d).padStart(2, '0')}`;
  return { start: iso(day), end: i % 4 === 0 ? iso(Math.min(31, day + 2)) : null };
}

/** The stages of the kanban mock: records cycle through them, every fifth one has none. */
export const STAGES = [
  { id: 'todo', name: 'To do', color: 'blue' },
  { id: 'doing', name: 'Doing', color: 'amber' },
  { id: 'done', name: 'Done', color: 'green' },
];

/** The collaborators of the mock directory; Bob only with `m2Types`. */
export const PEOPLE = {
  ada: uuid(7, 1),
  bob: uuid(7, 2),
};

/** Fields of the remaining types of (`mockApi(page, { m2Types: true })`). */
const m2Fields = () => [
  field(IDS.owner, 'Owner', 'user', 5, { multiple: true, notify: false }),
  field(IDS.code, 'Code', 'barcode', 6),
  field(IDS.open, 'Open', 'button', 7, {
    label: 'Open page',
    formula: `"https://openrows.io/f/" & ENCODE_URL_COMPONENT({${IDS.name}})`,
    resultType: 'text',
    referencedFieldIds: [IDS.name],
    isValid: true,
    precision: null,
    timeZone: 'UTC',
  }),
  field(IDS.brief, 'Brief', 'longText', 8, { richText: true }),
];

const CHOICES = [
  { id: 'planned', name: 'Planned', color: 'blue' },
  { id: 'progress', name: 'In progress', color: 'amber' },
  { id: 'shipped', name: 'Shipped', color: 'green' },
];

/** Fields of every editable type beyond the basic four (`mockApi(page, { allTypes: true })`). */
const typeFields = () => [
  field(IDS.status, 'Status', 'singleSelect', 5, { choices: CHOICES }),
  field(IDS.tags, 'Tags', 'multipleSelect', 6, { choices: CHOICES }),
  field(IDS.due, 'Due', 'date', 7, { dateFormat: 'iso' }),
  field(IDS.launch, 'Launch', 'dateTime', 8, {
    dateFormat: 'iso',
    timeFormat: '24h',
    timeZone: 'Europe/Paris',
  }),
  field(IDS.score, 'Score', 'rating', 9),
  field(IDS.site, 'Site', 'url', 10),
  field(IDS.mail, 'Mail', 'email', 11),
  field(IDS.phone, 'Phone', 'phone', 12),
  field(IDS.mockups, 'Mockups', 'attachment', 13),
];

/** A name the mock refuses (422), to show the inline save error. */
export const REJECTED = 'reject me';

const field = (id: string, name: string, type: string, position: number, options = {}) => ({
  id,
  tableId: IDS.table,
  name,
  description: null as string | null,
  type,
  options,
  isPrimary: position === 1,
  position,
  deletedAt: null as string | null,
  ...stamp,
});

export type MockApi = {
  /** Every request as `METHOD /path`. */
  calls: string[];
  /** Bodies of view PATCHes, in order. */
  viewPatches: Record<string, unknown>[];
  /** Offsets of record windows the grid asked for. */
  windows: number[];
  /** Bodies of record queries, in order (the toolbar's query goes with each). */
  queries: Record<string, unknown>[];
  /** Field writes as `METHOD /path` with their bodies, in order. */
  fieldWrites: { call: string; body: Record<string, unknown> | undefined }[];
  /** Records per bulk PATCH, in order. */
  bulkPatches: number[];
  /** Option names record writes with `typecast` created, in order. */
  typecasts: string[];
  /** The cells of the record at index `i`, as the mock holds them now. */
  fieldsAt: (i: number) => Record<string, unknown>;
  /** Live records (created ones included). */
  liveCount: () => number;
  /** Bodies of `POST /api/views/:viewId/order`, in order. */
  moves: { recordId: string; afterId: string | null }[];
  /** Bodies of `POST /api/tables/:tableId/views`, in order. */
  viewCreates: Record<string, unknown>[];
  /** Record writes that touched a field the role can't edit (the mock refuses them). */
  restrictedWrites: string[];
  /** Trash calls as `METHOD /path`, in order. */
  trashCalls: string[];
  /** Snapshot calls as `METHOD /path`, in order. */
  snapshotCalls: string[];
  /** The bodies of base duplicates started, in order. */
  duplicateBodies: unknown[];
  /** The bodies of template installs, in order. */
  templateInstalls: unknown[];
};

/** A person of the mocked workspace's collaborator directory. */
export type MockCollaborator = {
  id: string;
  name: string;
  email: string;
  initials: string;
  color: string;
};

/** `mockApi`'s `demo` option: every key is optional and changes nothing when left out. */
export type MockDemo = {
  /** The base's, the table's and the first view's names. */
  base?: string;
  table?: string;
  view?: string;
  /** The primary field of record `i` is `names[i]` (then "Record N" past the list). */
  names?: readonly string[];
  /** More cells of record `i` (field id → value), over the generated ones. */
  cells?: (i: number) => Record<string, unknown>;
  /** More fields on the table. */
  fields?: { id: string; name: string; type: string; position: number; options?: object }[];
  /** Merged into the first view's config (e.g. `grid.fieldOrder`, `kanban.cardFields`). */
  config?: Record<string, unknown>;
  /** The collaborator directory, instead of Ada (and Bob with `m2Types`). */
  collaborators?: MockCollaborator[];
};

export async function mockApi(
  /** A page, or a browser context to answer its service worker's requests too. */
  page: Page | BrowserContext,
  opts: {
    rows: number;
    allTypes?: boolean;
    m2Types?: boolean;
    /** A kanban view stacked by Stage, with a manual card order. */
    kanban?: boolean;
    /** A calendar view on Start – End, coloured by Stage. */
    calendar?: boolean;
    /** A gallery view with an image cover on every card. */
    gallery?: boolean;
    /** A timeline view on Start – End with dependencies (Depends on, a self link). */
    timeline?: boolean;
    /** A list view nested by Parent (a self link). */
    list?: boolean;
    /** A form view with Name and Stage on it. */
    form?: boolean;
    /** A Stage single select on the grid (row colours by select). */
    stage?: boolean;
    /** The view starts locked. */
    locked?: boolean;
    /** The signed-in user's role on the base (default owner). */
    role?: string;
    /** A second grid view, "Phone view", after the first. */
    secondView?: boolean;
    /** Field edit permissions by field id, e.g. `{ edit: { level: 'creators' } }`. */
    fieldPermissions?: Record<string, unknown>;
    /** An "Archive" table deleted 40 days ago, in the base's trash. */
    trashedTable?: boolean;
    /** Fields the worker is recomputing: `recomputing: true` on them. */
    recomputing?: string[];
    /** The plan's records per base: creates past it answer 403 quota-exceeded. */
    recordsPerBase?: number;
    /** The workspace's usage: GET /api/workspaces/:id/usage answers it. */
    usage?: unknown;
    /** The base's plan-limit warnings: GET /api/bases/:id/usage-warnings answers it. */
    usageWarnings?: unknown;
    /** Demo content instead of the generated one (the marketing site's screenshots). */
    demo?: MockDemo;
    /** More workspaces of the person than Ada's own ('s target picker). */
    workspaces?: { id: string; name: string; role: string | null }[];
    /**
     * The table is synced from another table: every field but Estimate is synced (the
     * spec mocks GET /api/tables/:id/sync itself).
     */
    synced?: boolean;
  }
): Promise<MockApi> {
  const state: MockApi = {
    calls: [],
    viewPatches: [],
    windows: [],
    queries: [],
    fieldWrites: [],
    bulkPatches: [],
    typecasts: [],
    fieldsAt: (i) => record(i).fields,
    liveCount: () => total - deleted.size - purged.size,
    moves: [],
    viewCreates: [],
    restrictedWrites: [],
    trashCalls: [],
    snapshotCalls: [],
    duplicateBodies: [],
    templateInstalls: [],
  };
  const fields: ReturnType<typeof field>[] = [
    field(IDS.name, 'Name', 'singleLineText', 1),
    field(IDS.notes, 'Notes', 'longText', 2),
    field(IDS.done, 'Done', 'checkbox', 3),
    field(IDS.estimate, 'Estimate', 'number', 4),
    ...(opts.allTypes ? typeFields() : []),
    ...(opts.m2Types ? m2Fields() : []),
    ...(opts.kanban || opts.calendar || opts.timeline || opts.stage || opts.form
      ? [field(IDS.stage, 'Stage', 'singleSelect', 5, { choices: STAGES })]
      : []),
    ...(opts.gallery ? [field(IDS.mockups, 'Mockups', 'attachment', 5)] : []),
    ...(opts.timeline
      ? [field(IDS.deps, 'Depends on', 'link', 8, { linkedTableId: IDS.table })]
      : []),
    ...(opts.list ? [field(IDS.parent, 'Parent', 'link', 5, { linkedTableId: IDS.table })] : []),
    ...(opts.calendar || opts.timeline
      ? [
          field(IDS.start, 'Start', 'date', 6, { dateFormat: 'iso' }),
          field(IDS.end, 'End', 'date', 7, { dateFormat: 'iso' }),
        ]
      : []),
    ...(opts.demo?.fields ?? []).map((f) => field(f.id, f.name, f.type, f.position, f.options)),
  ];
  for (const f of fields) {
    const permissions = opts.fieldPermissions?.[f.id];
    if (permissions) Object.assign(f, { permissions });
    if (opts.recomputing?.includes(f.id)) Object.assign(f, { recomputing: true });
    if (opts.synced && f.id !== IDS.estimate) Object.assign(f, { synced: true });
  }
  /** Fields the mock refuses for the role, as the server would (creators-only and nobody). */
  const refused = (cells: Record<string, unknown>) =>
    Object.keys(cells).filter((id) => {
      const level = (
        fields.find((f) => f.id === id) as { permissions?: { edit?: { level?: string } } }
      )?.permissions?.edit?.level;
      const creator = opts.role === undefined || opts.role === 'owner' || opts.role === 'creator';
      return level === 'nobody' || (level === 'creators' && !creator);
    });
  const forbidden = (route: Route, ids: string[]) => {
    state.restrictedWrites.push(...ids);
    return route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      body: JSON.stringify({
        type: 'about:blank',
        title: 'Editing restricted',
        status: 403,
        detail: "You don't have permission to edit that field.",
        code: 'EDIT_RESTRICTED',
        requestId: 'req-mock',
      }),
    });
  };
  const table = {
    id: IDS.table,
    baseId: IDS.base,
    name: opts.demo?.table ?? 'Features',
    description: null,
    icon: null,
    position: 1,
    schemaVersion: 1,
    ...(opts.synced ? { synced: true } : {}),
    ...stamp,
  };
  const kind = opts.kanban
    ? 'kanban'
    : opts.calendar
      ? 'calendar'
      : opts.gallery
        ? 'gallery'
        : opts.timeline
          ? 'timeline'
          : opts.list
            ? 'list'
            : opts.form
              ? 'form'
              : 'grid';
  const VIEW_SETUP: Record<string, { name: string; config: Record<string, unknown> }> = {
    grid: { name: 'All features', config: {} },
    kanban: { name: 'By stage', config: { kanban: { stackFieldId: IDS.stage } } },
    calendar: {
      name: 'Launch calendar',
      config: { calendar: { dateFields: [{ startFieldId: IDS.start, endFieldId: IDS.end }] } },
    },
    gallery: { name: 'Gallery', config: { gallery: { coverFieldId: IDS.mockups } } },
    timeline: {
      name: 'Roadmap',
      config: {
        timeline: { startFieldId: IDS.start, endFieldId: IDS.end, dependencyFieldId: IDS.deps },
      },
    },
    list: { name: 'Outline', config: { list: { parentFieldId: IDS.parent } } },
    form: {
      name: 'Feature request',
      config: { form: { fields: [{ fieldId: IDS.name }, { fieldId: IDS.stage }] } },
    },
  };
  const view = {
    id: IDS.view,
    tableId: IDS.table,
    name: opts.demo?.view ?? VIEW_SETUP[kind]?.name ?? 'All features',
    type: kind,
    position: 1,
    config: { ...VIEW_SETUP[kind]?.config, ...opts.demo?.config } as Record<string, unknown>,
    personal: false,
    locked: opts.locked ?? false,
    sectionId: null as string | null,
    createdBy: null as string | null,
    ...stamp,
  };
  /** Views created through the API. */
  const createdViews: (typeof view)[] = [];
  let total = opts.rows;
  const deleted = new Set<number>();
  /** Records deleted permanently: out of every list for good. */
  const purged = new Set<number>();
  /** When records (by index) and fields (by id) went to the trash, on the browser's clock. */
  const trashedAt = new Map<number | string, string>();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const purgeAfter = (at: string) => new Date(Date.parse(at) + 30 * DAY_MS).toISOString();
  const archive = {
    ...table,
    id: uuid(3, 2),
    name: 'Archive',
    position: 2,
    state: opts.trashedTable ? ('trash' as 'trash' | 'live' | 'gone') : ('gone' as const),
    deletedAt: new Date(Date.now() - 40 * DAY_MS).toISOString(),
  };
  const oldBaseDeleted = new Date(Date.now() - 3 * DAY_MS).toISOString();
  const oldBase = {
    state: 'trash' as 'trash' | 'live',
    item: {
      id: uuid(2, 2),
      name: 'Old roadmap',
      deletedAt: oldBaseDeleted,
      deletedBy: PEOPLE.ada,
      purgeAfter: purgeAfter(oldBaseDeleted),
    },
    base: {
      id: uuid(2, 2),
      workspaceId: IDS.workspace,
      name: 'Old roadmap',
      description: null,
      icon: null,
      color: null,
      ...stamp,
    },
  };
  // Base snapshots.
  const RESTORED_BASE = uuid(2, 9);
  const RESTORE_JOB = uuid(9, 99);
  let restoredBase = false;
  let restorePolls = 0;
  let restoreSnapshotId = '';
  let retentionDays = 30;
  // Base duplicates: polled once running (1 of 3 records), then done.
  const COPY_BASE = uuid(2, 10);
  const DUPLICATE_JOB = uuid(9, 98);
  let duplicatePolls = 0;
  let duplicateBody: { name?: string; workspaceId?: string; withRecords?: boolean } = {};
  const restoredBaseOf = () => ({
    ...oldBase.base,
    id: RESTORED_BASE,
    name: 'Product Roadmap (restored)',
    role: 'owner',
  });
  const snapshotOf = (id: string, kind: 'manual' | 'auto', at: Date) => ({
    id,
    baseId: IDS.base,
    baseName: 'Product Roadmap',
    kind,
    size: 1_258_291,
    tables: 1,
    records: opts.rows,
    createdBy: kind === 'manual' ? PEOPLE.ada : null,
    createdAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + retentionDays * DAY_MS).toISOString(),
  });
  const snapshots = [snapshotOf(uuid(9, 99), 'auto', new Date(Date.now() - DAY_MS))];
  const liveTables = () => {
    const { state: archived, deletedAt: _at, ...rest } = archive;
    return archived === 'live' ? [table, rest] : [table];
  };
  const edits = new Map<number, Record<string, unknown>>();
  /** The kanban view's manual order: record indexes moved so far, in order. */
  let manual: number[] = [];
  const versions = new Map<number, number>();

  /** Formula cells, computed on read from the stored form with the shared evaluator. */
  const withFormulas = (cells: Record<string, unknown>) => {
    const out = { ...cells };
    for (const f of fields) {
      if (!hasFormula(f.type) || f.deletedAt) continue;
      const parsed = parseStoredFormula(String((f.options as { formula?: unknown }).formula));
      const read = (id: string) => {
        const source = fields.find((x) => x.id === id);
        return source ? fieldFormulaValue(source, cells[id] ?? null) : null;
      };
      const result = parsed.ok
        ? formulaResult(evaluateFormula(parsed.ast, { field: read }))
        : '#ERROR!';
      // A button keeps only an http(s) URL, as the server does.
      out[f.id] = isFieldTypeName(f.type) ? getFieldType(f.type).coerce(result, f.options) : result;
    }
    return out;
  };

  const record = (i: number) => ({
    id: uuid(6, i),
    tableId: IDS.table,
    version: versions.get(i) ?? 1,
    fields: withFormulas({
      [IDS.name]: opts.demo?.names?.[i] ?? `Record ${i + 1}`,
      [IDS.notes]: i % 3 === 0 ? `Note for ${i + 1}` : null,
      [IDS.done]: i % 2 === 0,
      [IDS.estimate]: (i % 13) + 1,
      ...(opts.kanban || opts.calendar || opts.timeline || opts.stage
        ? { [IDS.stage]: i % 5 === 4 ? null : (STAGES[i % 3]?.id ?? null) }
        : {}),
      ...(opts.calendar || opts.timeline
        ? { [IDS.start]: calendarDates(i).start, [IDS.end]: calendarDates(i).end }
        : {}),
      ...(opts.gallery
        ? {
            [IDS.mockups]: [
              { id: `img-${i}`, filename: `cover-${i + 1}.png`, size: 1024, type: 'image/png' },
            ],
          }
        : {}),
      ...(opts.timeline ? { [IDS.deps]: linkTo(dependsOn(i)) } : {}),
      ...(opts.list ? { [IDS.parent]: linkTo(parentOf(i)) } : {}),
      ...(opts.allTypes && i === 0
        ? {
            [IDS.mockups]: [
              { id: 'f1', filename: 'grid.png', size: 2048, type: 'image/png' },
              { id: 'f2', filename: 'spec.pdf', size: 4096, type: 'application/pdf' },
            ],
          }
        : {}),
      ...opts.demo?.cells?.(i),
      ...edits.get(i),
    }),
    createdBy: null,
    updatedBy: null,
    ...stamp,
  });
  /** A link cell naming record `j` (as the server reads it: id and primary text). */
  function linkTo(j: number | null) {
    return j === null ? null : [{ id: uuid(6, j), name: `Record ${j + 1}` }];
  }
  const indexOf = (recordId: string) => Number.parseInt(recordId.slice(-12), 16);
  const live = () =>
    Array.from({ length: total }, (_, i) => i).filter((i) => !deleted.has(i) && !purged.has(i));

  /**
   * Select typecast, roughly as the server does it: names in select cells that match no
   * option become options of the field; cells come back as option ids.
   */
  const typecast = (cells: Record<string, unknown>) => {
    const out: Record<string, unknown> = { ...cells };
    for (const [fieldId, raw] of Object.entries(cells)) {
      const f = fields.find((x) => x.id === fieldId);
      if (!f || (f.type !== 'singleSelect' && f.type !== 'multipleSelect')) continue;
      const options = f.options as { choices?: { id: string; name: string; color: string }[] };
      options.choices ??= [];
      const choices = options.choices;
      const names = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
        .map((n) => String(n).trim())
        .filter((n) => n !== '');
      const ids = names.map((name) => {
        const found = choices.find(
          (c) => c.id === name || c.name.toLowerCase() === name.toLowerCase()
        );
        if (found) return found.id;
        const created = { id: `sel-${choices.length}`, name, color: 'violet' };
        choices.push(created);
        state.typecasts.push(name);
        return created.id;
      });
      out[fieldId] = f.type === 'singleSelect' ? (ids[0] ?? null) : ids.length ? ids : null;
    }
    return out;
  };
  /** Writes as the server stores them. */
  const coerced = (cells: Record<string, unknown>) => {
    const out = { ...cells };
    for (const [fieldId, raw] of Object.entries(cells)) {
      const f = fields.find((x) => x.id === fieldId);
      if (f && ['user', 'barcode', 'longText'].includes(f.type) && isFieldTypeName(f.type)) {
        const def = getFieldType(f.type);
        out[fieldId] = def.coerce(raw, def.optionsSchema.parse(f.options));
      }
    }
    return out;
  };
  const cellsOf = (cells: Record<string, unknown>, body: { typecast?: boolean }) =>
    coerced(body.typecast ? typecast(cells) : cells);

  const json = (route: Route, data: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const body = req.postData() ? JSON.parse(req.postData() ?? '{}') : undefined;
    state.calls.push(`${method} ${path}`);

    if (path === '/api/me') {
      return json(route, {
        user: {
          id: uuid(7, 1),
          email: 'ada@example.test',
          name: 'Ada Lovelace',
          avatarUrl: null,
          isSystemAdmin: false,
        },
        session: { createdAt: now, expiresAt: '2026-11-24T10:00:00.000Z' },
      });
    }
    // No service notices: their banner stays out of the mocked specs.
    if (path === '/api/me/notices') return json(route, { notices: [] });
    if (path === '/api/workspaces') {
      return json(route, {
        workspaces: [
          { id: IDS.workspace, name: 'Ada', role: 'owner', ...stamp },
          ...(opts.workspaces ?? []).map((w) => ({ ...w, ...stamp })),
        ],
      });
    }
    if (path === `/api/workspaces/${IDS.workspace}/usage` && opts.usage) {
      return json(route, opts.usage);
    }
    if (path === `/api/bases/${IDS.base}/usage-warnings` && opts.usageWarnings) {
      return json(route, opts.usageWarnings);
    }
    if (path === `/api/workspaces/${IDS.workspace}/collaborators`) {
      return json(route, {
        collaborators: opts.demo?.collaborators ?? [
          {
            id: PEOPLE.ada,
            name: 'Ada Lovelace',
            email: 'ada@example.test',
            initials: 'AL',
            color: 'violet',
          },
          ...(opts.m2Types
            ? [
                {
                  id: PEOPLE.bob,
                  name: 'Bob Builder',
                  email: 'bob@example.test',
                  initials: 'BB',
                  color: 'green',
                },
              ]
            : []),
        ],
      });
    }
    // The workspace's trash: one deleted base, "Old roadmap".
    if (path === `/api/workspaces/${IDS.workspace}/trash`) {
      state.trashCalls.push(`${method} ${path}`);
      return json(route, { bases: oldBase.state === 'trash' ? [oldBase.item] : [] });
    }
    if (
      path === `/api/workspaces/${IDS.workspace}/trash/bases/${oldBase.item.id}/restore` &&
      method === 'POST'
    ) {
      state.trashCalls.push(`${method} ${path}`);
      oldBase.state = 'live';
      return json(route, { ...oldBase.base, role: 'owner' });
    }
    // Base snapshots: one automatic snapshot from yesterday; "Snapshot now" adds one,
    // restore makes the "Product Roadmap (restored)" base.
    if (path.includes('/snapshot')) state.snapshotCalls.push(`${method} ${path}`);
    if (path === `/api/bases/${IDS.base}/snapshots` && method === 'GET') {
      return json(route, { snapshots: [...snapshots].reverse(), retentionDays });
    }
    if (path === `/api/bases/${IDS.base}/snapshots` && method === 'POST') {
      const at = new Date();
      const taken = snapshotOf(uuid(9, snapshots.length + 1), 'manual', at);
      snapshots.push(taken);
      return json(route, taken, 201);
    }
    // A restore runs in the worker: the job is polled until the base exists.
    const restoreJobOf = (snapshotId: string, done: boolean) => ({
      id: RESTORE_JOB,
      snapshotId,
      status: done ? 'done' : 'running',
      base: done ? restoredBaseOf() : null,
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: done ? new Date().toISOString() : null,
    });
    if (path === `/api/bases/${IDS.base}/snapshot-restores/${RESTORE_JOB}` && method === 'GET') {
      restorePolls++;
      // Running on the first poll, done on the next.
      if (restorePolls > 1) restoredBase = true;
      return json(route, restoreJobOf(restoreSnapshotId, restorePolls > 1));
    }
    const snapshotPath = /^\/api\/bases\/[^/]+\/snapshots\/([^/]+)(\/restore)?$/.exec(path);
    if (snapshotPath && method === 'POST') {
      restoreSnapshotId = snapshotPath[1] ?? '';
      restorePolls = 0;
      return json(route, restoreJobOf(restoreSnapshotId, false), 201);
    }
    if (snapshotPath && method === 'DELETE') {
      const i = snapshots.findIndex((x) => x.id === snapshotPath[1]);
      if (i >= 0) snapshots.splice(i, 1);
      return route.fulfill({ status: 204 });
    }
    if (path === `/api/workspaces/${IDS.workspace}/snapshot-settings` && method === 'PATCH') {
      retentionDays = (route.request().postDataJSON() as { retentionDays: number }).retentionDays;
      return json(route, { retentionDays });
    }
    const copyBaseOf = () => ({
      ...oldBase.base,
      id: COPY_BASE,
      workspaceId: duplicateBody.workspaceId ?? IDS.workspace,
      name: duplicateBody.name ?? 'Product Roadmap copy',
      role: 'owner',
    });
    const duplicateJobOf = (done: boolean) => ({
      id: DUPLICATE_JOB,
      baseId: IDS.base,
      workspaceId: duplicateBody.workspaceId ?? IDS.workspace,
      withRecords: duplicateBody.withRecords ?? false,
      status: done ? 'done' : 'running',
      progress: duplicateBody.withRecords
        ? { records: done ? opts.rows : 1, totalRecords: opts.rows }
        : { records: 0, totalRecords: 0 },
      base: done ? copyBaseOf() : null,
      error: null,
      createdAt: now,
      finishedAt: done ? now : null,
    });
    if (path === `/api/bases/${IDS.base}/duplicate` && method === 'POST') {
      duplicateBody = route.request().postDataJSON() as typeof duplicateBody;
      state.duplicateBodies.push(duplicateBody);
      duplicatePolls = 0;
      return json(route, duplicateJobOf(false), 201);
    }
    if (path === `/api/bases/${IDS.base}/duplicates/${DUPLICATE_JOB}` && method === 'GET') {
      duplicatePolls++;
      return json(route, duplicateJobOf(duplicatePolls > 1));
    }
    if (path === `/api/bases/${COPY_BASE}`) return json(route, copyBaseOf());
    if (path === `/api/bases/${COPY_BASE}/tables`) return json(route, { tables: [] });
    // Templates: the built-in gallery; an install "creates" the mocked base.
    if (path === '/api/templates' && method === 'GET') {
      return json(route, { templates: BUILT_IN_TEMPLATES.map(templateSummary) });
    }
    const templatePath = /^\/api\/templates\/([a-z0-9-]+)$/.exec(path);
    if (templatePath && method === 'GET') {
      const template = findTemplate(templatePath[1] ?? '');
      return template
        ? json(route, template)
        : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    }
    if (/^\/api\/workspaces\/[0-9a-f-]{36}\/templates$/.test(path) && method === 'POST') {
      state.templateInstalls.push(route.request().postDataJSON());
      return json(route, copyBaseOf(), 201);
    }
    if (path === `/api/bases/${RESTORED_BASE}`) return json(route, restoredBaseOf());
    if (path === `/api/bases/${RESTORED_BASE}/tables`) return json(route, { tables: [] });
    if (path === `/api/workspaces/${IDS.workspace}/bases` || path === `/api/bases/${IDS.base}`) {
      const base = {
        id: IDS.base,
        workspaceId: IDS.workspace,
        name: opts.demo?.base ?? 'Product Roadmap',
        description: null,
        icon: null,
        color: null,
        role: opts.role ?? 'owner',
        ...stamp,
      };
      const restored = [
        ...(oldBase.state === 'live' ? [{ ...oldBase.base, role: 'owner' }] : []),
        ...(restoredBase ? [restoredBaseOf()] : []),
      ];
      return json(route, path.endsWith('/bases') ? { bases: [base, ...restored] } : base);
    }
    if (path === `/api/bases/${IDS.base}/tables`) return json(route, { tables: liveTables() });
    // The trash: deleted records, fields and the Archive table; restore and purge.
    if (path.includes('/trash')) state.trashCalls.push(`${method} ${path}`);
    if (path === `/api/bases/${IDS.base}/trash`) {
      return json(route, {
        tables:
          archive.state === 'trash'
            ? [
                {
                  id: archive.id,
                  name: archive.name,
                  deletedAt: archive.deletedAt,
                  deletedBy: PEOPLE.ada,
                  purgeAfter: purgeAfter(archive.deletedAt),
                },
              ]
            : [],
        fields: fields
          .filter((f) => f.deletedAt)
          .map((f) => {
            const at = trashedAt.get(f.id) ?? new Date().toISOString();
            return {
              id: f.id,
              name: f.name,
              deletedAt: at,
              deletedBy: PEOPLE.ada,
              purgeAfter: purgeAfter(at),
              tableId: IDS.table,
              tableName: table.name,
              type: f.type,
              inverse: null,
            };
          }),
        views: [],
      });
    }
    if (path === `/api/tables/${IDS.table}/trash/records`) {
      return json(route, {
        records: [...deleted].reverse().map((i) => {
          const at = trashedAt.get(i) ?? new Date().toISOString();
          return {
            id: record(i).id,
            name: String(record(i).fields[IDS.name] ?? ''),
            deletedAt: at,
            deletedBy: PEOPLE.ada,
            purgeAfter: purgeAfter(at),
          };
        }),
        nextCursor: null,
      });
    }
    if (path === `/api/tables/${IDS.table}/trash/records/purge` && method === 'POST') {
      for (const id of body.recordIds) {
        deleted.delete(indexOf(id));
        purged.add(indexOf(id));
      }
      return json(route, { purged: body.recordIds.length });
    }
    const purgedField = path.match(/^\/api\/tables\/[^/]+\/trash\/fields\/([^/]+)$/)?.[1];
    if (purgedField && method === 'DELETE') {
      const i = fields.findIndex((f) => f.id === purgedField && f.deletedAt);
      if (i < 0) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      fields.splice(i, 1);
      return route.fulfill({ status: 204 });
    }
    if (path === `/api/bases/${IDS.base}/trash/tables/${archive.id}/restore` && method === 'POST') {
      archive.state = 'live';
      return json(route, { ...liveTables()[1], fields: [] });
    }
    if (path === `/api/tables/${IDS.table}`) {
      return json(route, { ...table, fields: fields.filter((f) => !f.deletedAt) });
    }
    // Field management: create, update, trash and restore.
    const fieldId = path.match(/^\/api\/fields\/([^/]+)$/)?.[1];
    const restoreId = path.match(/^\/api\/tables\/[^/]+\/fields\/([^/]+)\/restore$/)?.[1];
    if (path === `/api/tables/${IDS.table}/fields` || fieldId || restoreId) {
      state.fieldWrites.push({ call: `${method} ${path}`, body });
    }
    if (path === `/api/tables/${IDS.table}/fields` && method === 'POST') {
      const position = body.position ?? Math.max(...fields.map((f) => f.position)) + 1;
      const created = {
        ...field(uuid(5, 100 + fields.length), body.name, body.type, position, body.options),
        isPrimary: false,
        description: body.description ?? null,
      };
      fields.push(created);
      fields.sort((a, b) => a.position - b.position);
      return json(route, created, 201);
    }
    const target = fields.find((f) => f.id === (fieldId ?? restoreId));
    if (fieldId && target && method === 'PATCH') {
      Object.assign(target, body);
      if (body.type || body.options) {
        // The mock keeps no converted values: the grid shows the field's cells as empty.
        for (const [, e] of edits) delete e[target.id];
      }
      return json(route, target);
    }
    if (fieldId && target && method === 'DELETE') {
      target.deletedAt = now;
      trashedAt.set(target.id, new Date().toISOString());
      return route.fulfill({ status: 204 });
    }
    if (restoreId && target && method === 'POST') {
      target.deletedAt = null;
      return json(route, target);
    }
    if (path === `/api/tables/${IDS.table}/views` && method === 'POST') {
      state.viewCreates.push(body);
      const created = {
        ...view,
        id: uuid(4, 100 + state.viewCreates.length),
        name: body.name,
        type: body.type ?? 'grid',
        position: 10 + state.viewCreates.length,
        config: {},
        personal: body.personal ?? false,
        locked: false,
        createdBy: uuid(7, 1),
      };
      createdViews.push(created);
      return json(route, created, 201);
    }
    if (path === `/api/tables/${IDS.table}/views`) {
      const second = { ...view, id: IDS.view2, name: 'Phone view', type: 'grid', position: 2 };
      return json(route, {
        views: [...(opts.secondView ? [view, second] : [view]), ...createdViews],
        sections: [],
      });
    }
    if (path === `/api/views/${IDS.view}` && method === 'PATCH') {
      state.viewPatches.push(body);
      const grid = { ...(view.config['grid'] as object), ...body.grid };
      const kanban = { ...(view.config['kanban'] as object), ...body.kanban };
      const calendar = { ...(view.config['calendar'] as object), ...body.calendar };
      const layouts = Object.fromEntries(
        (['gallery', 'timeline', 'list', 'form'] as const).map((k) => [
          k,
          { ...(view.config[k] as object), ...body[k] },
        ])
      );
      view.config = { ...view.config, ...body.query, grid, kanban, calendar, ...layouts };
      if ('rowColor' in body) view.config['rowColor'] = body.rowColor;
      if (typeof body.locked === 'boolean') view.locked = body.locked;
      return json(route, view);
    }
    if (path === `/api/views/${IDS.view}/order` && method === 'POST') {
      state.moves.push(body);
      const moved = indexOf(body.recordId);
      const all = [...manual, ...live().filter((i) => !manual.includes(i))];
      manual = all.filter((i) => i !== moved);
      const after = body.afterId === null ? -1 : manual.indexOf(indexOf(body.afterId));
      manual.splice(after + 1, 0, moved);
      return route.fulfill({ status: 204 });
    }
    if (path === `/api/tables/${IDS.table}/records/query`) {
      const offset: number = body.offset ?? 0;
      const limit: number = body.limit ?? 100;
      state.windows.push(offset);
      state.queries.push(body);
      const records = [];
      const query = { ...view.config, ...body.query } as MockQuery;
      let ids = live();
      // A kanban view without sorts: the manual order first, then the rest oldest first.
      if (view.type === 'kanban' && !(query.sorts ?? []).length && manual.length) {
        const rest = ids.filter((i) => !manual.includes(i));
        ids = [...manual.filter((i) => ids.includes(i)), ...rest];
      }
      if (query.within?.length) {
        ids = ids.filter((i) => matches(record(i).fields, { conditions: query.within ?? [] }));
      }
      // The calendar's window: ranges that meet the days, dates compared as text.
      const range = query.dateRange;
      if (range) {
        ids = ids.filter((i) => {
          const f = record(i).fields;
          return range.fields.some((p) => {
            const start = f[p.startFieldId];
            if (typeof start !== 'string') return false;
            const end = p.endFieldId ? f[p.endFieldId] : null;
            const last = typeof end === 'string' && end > start ? end : start;
            return start.slice(0, 10) <= range.to && last.slice(0, 10) >= range.from;
          });
        });
      }
      const matching = runQuery(ids, (i) => record(i).fields, query);
      for (const i of matching.slice(offset, offset + limit)) records.push(record(i));
      const aggregates: Record<string, Record<string, number>> = {};
      for (const a of body.aggregates ?? []) {
        aggregates[a.fieldId] = { [a.fn]: a.fn === 'sum' ? total * 7 : Math.ceil(total / 2) };
      }
      // Row colour conditions: the first condition each record matches.
      const conditions: { color: string; filter: MockFilter }[] = body.rowColors ?? [];
      const rowColors = Object.fromEntries(
        records.flatMap((r) => {
          const hit = conditions.find((c) => matches(r.fields, c.filter));
          return hit ? [[r.id, hit.color]] : [];
        })
      );
      return json(route, {
        records,
        offset,
        ...(body.rowColors ? { rowColors } : {}),
        total: body.count === false ? null : matching.length,
        nextCursor: null,
        ...(body.aggregates ? { aggregates } : {}),
        ...(body.groups ? { groups: leafGroups(matching, (i) => record(i).fields, query) } : {}),
      });
    }
    if (path === `/api/tables/${IDS.table}/records` && method === 'POST') {
      const adding = Array.isArray(body.records) ? body.records.length : 1;
      if (opts.recordsPerBase !== undefined && total + adding > opts.recordsPerBase) {
        const max = opts.recordsPerBase;
        return route.fulfill({
          status: 403,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'https://openrows.io/problems/quota-exceeded',
            title: 'Plan limit reached',
            status: 403,
            detail: `This base has ${total} of the ${max} records its plan allows. Existing records can still be read and edited; upgrade the plan to add more.`,
            code: 'QUOTA_EXCEEDED',
            requestId: 'req-mock',
            limit: 'recordsPerBase',
            used: total,
            max,
          }),
        });
      }
      if (Array.isArray(body.records)) {
        const created = body.records.map((r: { fields: Record<string, unknown> }) => {
          total += 1;
          edits.set(total - 1, {
            [IDS.name]: null,
            [IDS.notes]: null,
            [IDS.done]: false,
            [IDS.estimate]: null,
            ...cellsOf(r.fields, body),
          });
          return record(total - 1);
        });
        return json(route, { records: created }, 201);
      }
      total += 1;
      if (body.fields) {
        const blank = opts.calendar ? { [IDS.end]: null, [IDS.stage]: null } : {};
        edits.set(total - 1, { [IDS.name]: null, ...blank, ...cellsOf(body.fields, body) });
      }
      return json(route, record(total - 1), 201);
    }
    // Bulk patch: paste, fill, clear and undo.
    if (path === `/api/tables/${IDS.table}/records` && method === 'PATCH') {
      const denied = body.records.flatMap((r: { fields: Record<string, unknown> }) =>
        refused(r.fields)
      );
      if (denied.length) return forbidden(route, denied);
      state.bulkPatches.push(body.records.length);
      const saved = body.records.map((r: { id: string; fields: Record<string, unknown> }) => {
        const i = indexOf(r.id);
        edits.set(i, { ...edits.get(i), ...cellsOf(r.fields, body) });
        versions.set(i, (versions.get(i) ?? 1) + 1);
        return record(i);
      });
      return json(route, { records: saved });
    }
    // Delete and restore: the mock only takes records out of `total` from the end.
    if (path === `/api/tables/${IDS.table}/records/delete` && method === 'POST') {
      for (const id of body.recordIds) {
        deleted.add(indexOf(id));
        trashedAt.set(indexOf(id), new Date().toISOString());
      }
      return json(route, {
        records: body.recordIds.map((id: string) => ({ id, deleted: true })),
      });
    }
    if (path === `/api/tables/${IDS.table}/records/restore` && method === 'POST') {
      for (const id of body.recordIds) deleted.delete(indexOf(id));
      return json(route, { records: body.recordIds.map((id: string) => record(indexOf(id))) });
    }
    const recordId = path.match(/^\/api\/tables\/[^/]+\/records\/([^/]+)$/)?.[1];
    if (recordId && method === 'GET') {
      const i = indexOf(recordId);
      if (i >= total || deleted.has(i)) {
        return route.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          body: JSON.stringify({ type: 'about:blank', title: 'Not found', status: 404 }),
        });
      }
      return json(route, record(i));
    }
    if (recordId && method === 'PATCH') {
      const i = indexOf(recordId);
      const denied = refused(body.fields);
      if (denied.length) return forbidden(route, denied);
      if (Object.values(body.fields).includes(REJECTED)) {
        return route.fulfill({
          status: 422,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Validation failed',
            status: 422,
            detail: 'That value was refused',
            code: 'VALIDATION_FAILED',
            requestId: 'req-mock',
          }),
        });
      }
      edits.set(i, { ...edits.get(i), ...cellsOf(body.fields, body) });
      versions.set(i, (versions.get(i) ?? 1) + 1);
      return json(route, record(i));
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  return state;
}

export const GRID_URL = `/b/${IDS.base}/${IDS.table}/${IDS.view}`;

/** The id of the mock's record at index `i` (zero-based). */
export const recordIdAt = (i: number) => uuid(6, i);

type MockCondition = { fieldId: string; operator: string; value?: unknown };
type MockFilter = { conjunction?: 'and' | 'or'; conditions: (MockCondition | MockFilter)[] };
type MockSort = { fieldId: string; direction: 'asc' | 'desc' };
type MockQuery = {
  filter?: MockFilter;
  sorts?: MockSort[];
  groupBy?: MockSort[];
  search?: string;
  within?: MockCondition[];
  dateRange?: {
    from: string;
    to: string;
    fields: { startFieldId: string; endFieldId?: string | null }[];
  };
};
type Fields = Record<string, unknown>;

// A small stand-in for the server's ViewQuery engine: enough operators for the specs
// (text contains/is, checkbox is, number comparisons, empty checks), sorts, groups and search
// on the primary field.
function matches(f: Fields, c: MockCondition | MockFilter): boolean {
  if ('conditions' in c) {
    const live = c.conditions.filter((x) => 'conditions' in x || complete(x));
    if (live.length === 0) return true;
    return c.conjunction === 'or'
      ? live.some((x) => matches(f, x))
      : live.every((x) => matches(f, x));
  }
  const v = f[c.fieldId];
  const empty = v === null || v === undefined || v === '' || v === false;
  switch (c.operator) {
    case 'isEmpty':
      return empty;
    case 'isNotEmpty':
      return !empty;
    case 'contains':
      return String(v ?? '')
        .toLowerCase()
        .includes(String(c.value).toLowerCase());
    case 'is':
      return typeof c.value === 'boolean'
        ? (v === true) === c.value
        : String(v ?? '').toLowerCase() === String(c.value).toLowerCase();
    case '=':
      return v === c.value;
    case '>':
      return Number(v) > Number(c.value);
    case '<':
      return Number(v) < Number(c.value);
    default:
      return true;
  }
}
const complete = (c: MockCondition) =>
  c.operator === 'isEmpty' ||
  c.operator === 'isNotEmpty' ||
  (c.value !== undefined && c.value !== '');

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function runQuery(ids: number[], fields: (i: number) => Fields, q: MockQuery): number[] {
  const keys = [...(q.groupBy ?? []), ...(q.sorts ?? [])];
  const search = q.search?.trim().toLowerCase();
  if (!q.filter?.conditions.length && keys.length === 0 && !search) return ids;
  let out = ids.filter((i) => !q.filter || matches(fields(i), q.filter));
  if (search)
    out = out.filter((i) =>
      Object.values(fields(i)).some((v) =>
        String(v ?? '')
          .toLowerCase()
          .includes(search)
      )
    );
  if (keys.length > 0) {
    out = [...out].sort((x, y) => {
      for (const k of keys) {
        const c = compare(fields(x)[k.fieldId], fields(y)[k.fieldId]);
        if (c !== 0) return k.direction === 'desc' ? -c : c;
      }
      return x - y;
    });
  }
  return out;
}

function leafGroups(ids: number[], fields: (i: number) => Fields, q: MockQuery) {
  const groups: { key: unknown[]; count: number }[] = [];
  for (const i of ids) {
    const key = (q.groupBy ?? []).map((g) => fields(i)[g.fieldId] ?? null);
    const last = groups.at(-1);
    if (last && JSON.stringify(last.key) === JSON.stringify(key)) last.count++;
    else groups.push({ key, count: 1 });
  }
  return groups;
}
