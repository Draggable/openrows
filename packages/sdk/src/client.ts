import { V1_BATCH_MAX, V1_ENDPOINTS, type V1RecordsListPostResponse } from './generated/v1.js';
import { type CallInput, type ClientOptions, type Endpoint, HttpClient } from './http.js';
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
  AutomationTriggered,
  Base,
  Comment,
  CommentPage,
  CreateFieldInput,
  CreateTableInput,
  CreateWebhookInput,
  DeletedRecord,
  Field,
  FieldSet,
  FindOptions,
  OpenRowsRecord,
  RecordUpdate,
  SelectParams,
  TableSchema,
  UpdateFieldInput,
  UpdateWebhookInput,
  UpsertOptions,
  UpsertResult,
  Webhook,
  WebhookDelivery,
  WebhookWithSecret,
  WriteOptions,
} from './types.js';

const { v1Meta, v1Records, v1Comments, v1Webhooks, v1Automations } = V1_ENDPOINTS;

/** `items` in slices of at most `size`. */
export function chunks<T>(items: readonly T[], size = V1_BATCH_MAX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The OpenRows REST API v1 client.
 *
 * ```ts
 * const openrows = new OpenRows({ apiKey: process.env.OPENROWS_TOKEN });
 * const tasks = openrows.table(baseId, 'Tasks');
 * const done = await tasks.select({ filterByFormula: "{Status} = 'Done'" }).all();
 * ```
 */
export class OpenRows {
  /** @internal */
  readonly http: HttpClient;
  /** The bases the token (and its owner) can reach. */
  readonly bases: Bases;

  constructor(options: ClientOptions = {}) {
    this.http = new HttpClient(options);
    this.bases = {
      list: async () => (await this.http.call<{ bases: Base[] }>(v1Meta.bases)).bases,
    };
  }

  /** A base: its tables, a table, its webhooks. */
  base(baseId: string): BaseClient {
    return new BaseClient(this.http, baseId);
  }

  /** A base's tables (schema). */
  tables(baseId: string): Tables {
    return new Tables(this.http, baseId);
  }

  /** A table of a base, by id or name, to read and write its records. */
  table<F extends FieldSet = FieldSet>(baseId: string, tableIdOrName: string): Table<F> {
    return new Table<F>(this.http, baseId, tableIdOrName);
  }

  /** A base's webhooks (the `webhook:manage` scope and the base's creator role). */
  webhooks(baseId: string): Webhooks {
    return new Webhooks(this.http, baseId);
  }

  /**
   * A base's automations (the base's creator role; `automations:read`, `automations:manage` to
   * turn them on or off, `automations:run` to trigger them).
   */
  automations(baseId: string): Automations {
    return new Automations(this.http, baseId);
  }
}

/** The bases the caller can reach. */
export interface Bases {
  /** Every base the token (and its owner) can read, with the permission level. */
  list(): Promise<Base[]>;
}

/** A table's fields (the `schema.bases:write` scope and the creator role). */
export interface Fields {
  /** Adds a field; `type` is ours or Airtable's name for it. */
  create(field: CreateFieldInput): Promise<Field>;
  /** Renames a field or changes its description. */
  update(fieldId: string, change: UpdateFieldInput): Promise<Field>;
}

/** One base: `openrows.base(baseId)`. */
export class BaseClient {
  /** The base's tables (schema). */
  readonly tables: Tables;
  /** The base's webhooks. */
  readonly webhooks: Webhooks;
  /** The base's automations. */
  readonly automations: Automations;

  /** @internal */
  constructor(
    private readonly http: HttpClient,
    readonly id: string
  ) {
    this.tables = new Tables(http, id);
    this.webhooks = new Webhooks(http, id);
    this.automations = new Automations(http, id);
  }

  /** A table of the base, by id or name. */
  table<F extends FieldSet = FieldSet>(tableIdOrName: string): Table<F> {
    return new Table<F>(this.http, this.id, tableIdOrName);
  }
}

/** A base's tables: `openrows.tables(baseId)`. */
export class Tables {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    readonly baseId: string
  ) {}

  /** The base's tables with their fields (types and options) and views. */
  async list(): Promise<TableSchema[]> {
    const res = await this.http.call<{ tables: TableSchema[] }>(v1Meta.tables, {
      params: { baseId: this.baseId },
    });
    return res.tables;
  }

  /** Creates a table; its first field is the primary field. */
  create(table: CreateTableInput): Promise<TableSchema> {
    return this.http.call(v1Meta.createTable, { params: { baseId: this.baseId }, body: table });
  }

  /** A table of the base, by id or name. */
  table<F extends FieldSet = FieldSet>(tableIdOrName: string): Table<F> {
    return new Table<F>(this.http, this.baseId, tableIdOrName);
  }
}

/** A table's records, fields and comments. Writes of more than 10 records go 10 at a time. */
export class Table<F extends FieldSet = FieldSet> {
  /** The table's fields (schema). */
  readonly fields: Fields;

  /** @internal */
  constructor(
    private readonly http: HttpClient,
    readonly baseId: string,
    readonly tableIdOrName: string
  ) {
    const params = { baseId, tableIdOrName };
    this.fields = {
      create: (field) => http.call(v1Meta.createField, { params, body: field }),
      update: (fieldId, change) =>
        http.call(v1Meta.updateField, { params: { ...params, fieldId }, body: change }),
    };
  }

  private call<T>(endpoint: Endpoint, input: Omit<CallInput, 'params'> = {}, recordId?: string) {
    const params: Record<string, string> = {
      baseId: this.baseId,
      tableIdOrName: this.tableIdOrName,
    };
    if (recordId !== undefined) params['recordId'] = recordId;
    return this.http.call<T>(endpoint, { ...input, params });
  }

  /** A query over the table's records: `.all()`, `.firstPage()`, `.eachPage()` or `for await`. */
  select(params: SelectParams = {}): Query<F> {
    return new Query<F>((offset) =>
      this.call<V1RecordsListPostResponse>(v1Records.listPost, {
        body: { ...params, ...(offset ? { offset } : {}) },
      })
    );
  }

  /** One record by id. */
  find(recordId: string, options: FindOptions = {}): Promise<OpenRowsRecord<F>> {
    return this.call(v1Records.get, { query: { ...options } }, recordId);
  }

  /** Creates one record from its cells. */
  create(fields: Partial<F>, options?: WriteOptions): Promise<OpenRowsRecord<F>>;
  /** Creates records, in order, 10 per request. */
  create(records: { fields: Partial<F> }[], options?: WriteOptions): Promise<OpenRowsRecord<F>[]>;
  async create(
    input: Partial<F> | { fields: Partial<F> }[],
    options: WriteOptions = {}
  ): Promise<OpenRowsRecord<F> | OpenRowsRecord<F>[]> {
    if (!Array.isArray(input)) {
      return this.call(v1Records.create, { body: { fields: input, ...options } });
    }
    const out: OpenRowsRecord<F>[] = [];
    for (const batch of chunks(input)) {
      const res = await this.call<{ records: OpenRowsRecord<F>[] }>(v1Records.create, {
        body: { records: batch.map((r) => ({ fields: r.fields })), ...options },
      });
      out.push(...res.records);
    }
    return out;
  }

  /** Changes the cells given of one record; the others stay. */
  update(recordId: string, fields: Partial<F>, options?: WriteOptions): Promise<OpenRowsRecord<F>>;
  /** Changes the cells given of each record, 10 per request. */
  update(records: RecordUpdate<F>[], options?: WriteOptions): Promise<OpenRowsRecord<F>[]>;
  update(
    a: string | RecordUpdate<F>[],
    b?: Partial<F> | WriteOptions,
    c?: WriteOptions
  ): Promise<OpenRowsRecord<F> | OpenRowsRecord<F>[]> {
    return this.write('PATCH', a, b, c);
  }

  /** Replaces one record's cells: fields left out are cleared. */
  replace(recordId: string, fields: Partial<F>, options?: WriteOptions): Promise<OpenRowsRecord<F>>;
  /** Replaces each record's cells, 10 per request. */
  replace(records: RecordUpdate<F>[], options?: WriteOptions): Promise<OpenRowsRecord<F>[]>;
  replace(
    a: string | RecordUpdate<F>[],
    b?: Partial<F> | WriteOptions,
    c?: WriteOptions
  ): Promise<OpenRowsRecord<F> | OpenRowsRecord<F>[]> {
    return this.write('PUT', a, b, c);
  }

  private async write(
    method: 'PATCH' | 'PUT',
    a: string | RecordUpdate<F>[],
    b?: Partial<F> | WriteOptions,
    c?: WriteOptions
  ): Promise<OpenRowsRecord<F> | OpenRowsRecord<F>[]> {
    if (typeof a === 'string') {
      const endpoint = method === 'PATCH' ? v1Records.update : v1Records.replace;
      return this.call(endpoint, { body: { fields: b ?? {}, ...c } }, a);
    }
    const endpoint = method === 'PATCH' ? v1Records.updateMany : v1Records.replaceMany;
    const options = (b ?? {}) as WriteOptions;
    const out: OpenRowsRecord<F>[] = [];
    for (const batch of chunks(a)) {
      const res = await this.call<{ records: OpenRowsRecord<F>[] }>(endpoint, {
        body: { records: batch.map((r) => ({ id: r.id, fields: r.fields })), ...options },
      });
      out.push(...res.records);
    }
    return out;
  }

  /**
   * Updates the records that match on `fieldsToMergeOn` (or have an `id`) and creates the rest,
   * 10 per request. With `replace`, the fields left out of a matched record are cleared.
   */
  async upsert(
    records: { id?: string; fields: Partial<F> }[],
    options: UpsertOptions & { replace?: boolean }
  ): Promise<UpsertResult<F>> {
    const { fieldsToMergeOn, replace = false, ...rest } = options;
    const out: UpsertResult<F> = { records: [], createdRecords: [], updatedRecords: [] };
    for (const batch of chunks(records)) {
      const res = await this.call<Partial<UpsertResult<F>>>(
        replace ? v1Records.replaceMany : v1Records.updateMany,
        { body: { records: batch, performUpsert: { fieldsToMergeOn }, ...rest } }
      );
      out.records.push(...(res.records ?? []));
      out.createdRecords.push(...(res.createdRecords ?? []));
      out.updatedRecords.push(...(res.updatedRecords ?? []));
    }
    return out;
  }

  /** Moves one record to the trash. */
  destroy(recordId: string): Promise<DeletedRecord>;
  /** Moves records to the trash, 10 per request. */
  destroy(recordIds: string[]): Promise<DeletedRecord[]>;
  async destroy(ids: string | string[]): Promise<DeletedRecord | DeletedRecord[]> {
    if (typeof ids === 'string') return this.call(v1Records.delete, {}, ids);
    const out: DeletedRecord[] = [];
    for (const batch of chunks(ids)) {
      const res = await this.call<{ records: DeletedRecord[] }>(v1Records.deleteMany, {
        query: { 'records[]': batch },
      });
      out.push(...res.records);
    }
    return out;
  }

  /** A record's comments. */
  comments(recordId: string): Comments {
    return new Comments((endpoint, input) => this.call(endpoint, input, recordId));
  }
}

type RecordCall = <T>(endpoint: Endpoint, input?: Omit<CallInput, 'params'>) => Promise<T>;

/** A record's comments: `table.comments(recordId)`. */
export class Comments {
  /** @internal */
  constructor(private readonly call: RecordCall) {}

  /** One page of comments, newest first. */
  page(options: { pageSize?: number; offset?: string } = {}): Promise<CommentPage> {
    return this.call(v1Comments.list, { query: options });
  }

  /** Every comment, newest first. */
  async all(): Promise<Comment[]> {
    const out: Comment[] = [];
    let offset: string | undefined;
    do {
      const page = await this.page({ pageSize: 100, ...(offset ? { offset } : {}) });
      out.push(...page.comments);
      offset = page.offset ?? undefined;
    } while (offset);
    return out;
  }

  /** Posts a comment (`@[Name](user:<id>)` mentions someone). */
  create(text: string): Promise<Comment> {
    return this.call(v1Comments.create, { body: { text } });
  }
}

/**
 * A list of records, fetched a page at a time (at most 100 records each; `pageSize` and
 * `maxRecords` narrow it).
 */
export class Query<F extends FieldSet = FieldSet> {
  /** @internal */
  constructor(
    private readonly fetchPage: (offset?: string) => Promise<V1RecordsListPostResponse>
  ) {}

  /** The first page of records. */
  async firstPage(): Promise<OpenRowsRecord<F>[]> {
    return (await this.fetchPage()).records as OpenRowsRecord<F>[];
  }

  /** Calls `onPage` with each page in turn; answering `false` stops. */
  async eachPage(
    onPage: (records: OpenRowsRecord<F>[]) => unknown | Promise<unknown>
  ): Promise<void> {
    let offset: string | undefined;
    do {
      const page = await this.fetchPage(offset);
      if ((await onPage(page.records as OpenRowsRecord<F>[])) === false) return;
      offset = page.offset;
    } while (offset);
  }

  /** Every record, all pages. */
  async all(): Promise<OpenRowsRecord<F>[]> {
    const out: OpenRowsRecord<F>[] = [];
    await this.eachPage((records) => {
      out.push(...records);
    });
    return out;
  }

  /** `for await (const record of table.select())`: one page in memory at a time. */
  async *[Symbol.asyncIterator](): AsyncGenerator<OpenRowsRecord<F>> {
    let offset: string | undefined;
    do {
      const page = await this.fetchPage(offset);
      yield* page.records as OpenRowsRecord<F>[];
      offset = page.offset;
    } while (offset);
  }
}

/** A base's webhooks. */
export class Webhooks {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    readonly baseId: string
  ) {}

  private params(webhookId?: string): Record<string, string> {
    return webhookId ? { baseId: this.baseId, webhookId } : { baseId: this.baseId };
  }

  /** The base's webhooks (never their secrets). */
  async list(): Promise<Webhook[]> {
    const res = await this.http.call<{ webhooks: Webhook[] }>(v1Webhooks.list, {
      params: this.params(),
    });
    return res.webhooks;
  }

  /** Creates a webhook; the answer's `secret` is shown only this once. */
  create(webhook: CreateWebhookInput): Promise<WebhookWithSecret> {
    return this.http.call(v1Webhooks.create, { params: this.params(), body: webhook });
  }

  /** Changes, enables or disables a webhook; `{ rotateSecret: true }` answers a new `secret`. */
  update(webhookId: string, change: UpdateWebhookInput): Promise<WebhookWithSecret> {
    return this.http.call(v1Webhooks.update, { params: this.params(webhookId), body: change });
  }

  /** Deletes a webhook and its delivery log. */
  async delete(webhookId: string): Promise<void> {
    await this.http.call(v1Webhooks.delete, { params: this.params(webhookId) });
  }

  /** The webhook's delivery attempts of the last 7 days, newest first. */
  async deliveries(
    webhookId: string,
    options: { limit?: number } = {}
  ): Promise<WebhookDelivery[]> {
    const res = await this.http.call<{ deliveries: WebhookDelivery[] }>(v1Webhooks.deliveries, {
      params: this.params(webhookId),
      query: options,
    });
    return res.deliveries;
  }

  /** Sends a signed `ping` now and answers with the attempt. */
  ping(webhookId: string): Promise<WebhookDelivery> {
    return this.http.call(v1Webhooks.ping, { params: this.params(webhookId) });
  }

  /**
   * Queues a logged delivery's event again, with the same event id; the attempt shows in
   * `deliveries` once the worker sent it. Not for pings, nor while the webhook is off (409).
   */
  redeliver(webhookId: string, deliveryId: string): Promise<{ queued: true; eventId: string }> {
    return this.http.call(v1Webhooks.redeliver, {
      params: { ...this.params(webhookId), deliveryId },
    });
  }
}

/** A base's automations: built in the app, listed, switched and triggered here. */
export class Automations {
  /** @internal */
  constructor(
    private readonly http: HttpClient,
    readonly baseId: string
  ) {}

  private params(automationId: string): Record<string, string> {
    return { baseId: this.baseId, automationId };
  }

  /** The base's automations. */
  async list(): Promise<Automation[]> {
    const res = await this.http.call<{ automations: Automation[] }>(v1Automations.list, {
      params: { baseId: this.baseId },
    });
    return res.automations;
  }

  /** One automation. */
  get(automationId: string): Promise<Automation> {
    return this.http.call(v1Automations.get, { params: this.params(automationId) });
  }

  /** Turns an automation on (it then runs as you) or off. */
  setEnabled(automationId: string, enabled: boolean): Promise<Automation> {
    return this.http.call(v1Automations.update, {
      params: this.params(automationId),
      body: { enabled },
    });
  }

  /** The automation's runs of the last 30 days, newest first. */
  async runs(
    automationId: string,
    options: { limit?: number; status?: AutomationRunStatus } = {}
  ): Promise<AutomationRun[]> {
    const res = await this.http.call<{ runs: AutomationRun[] }>(v1Automations.runs, {
      params: this.params(automationId),
      query: options,
    });
    return res.runs;
  }

  /**
   * Triggers a webhook-received automation with `{ body }` (any JSON, as if POSTed to its URL)
   * or a button-clicked one with `{ recordId }` (a click on that record's button, as you).
   */
  trigger(
    automationId: string,
    input: { body?: unknown; recordId?: string } = {}
  ): Promise<AutomationTriggered> {
    return this.http.call(v1Automations.trigger, {
      params: this.params(automationId),
      body: input,
    });
  }
}
