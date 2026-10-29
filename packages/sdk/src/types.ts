import type {
  V1AutomationsGetResponse,
  V1AutomationsRunsResponse,
  V1AutomationsTriggerResponse,
  V1CommentsCreateResponse,
  V1CommentsListResponse,
  V1MetaBasesResponse,
  V1MetaCreateFieldBody,
  V1MetaCreateTableBody,
  V1MetaTablesResponse,
  V1MetaUpdateFieldBody,
  V1RecordsDeleteResponse,
  V1RecordsGetQuery,
  V1RecordsGetResponse,
  V1RecordsListPostBody,
  V1WebhooksCreateBody,
  V1WebhooksCreateResponse,
  V1WebhooksDeliveriesResponse,
  V1WebhooksListResponse,
  V1WebhooksUpdateBody,
} from './generated/v1.js';

/** A record's cells by field name (or by field id with `returnFieldsByFieldId`). */
export type FieldSet = Record<string, unknown>;

/** A record: its id, when it was created and its non-empty cells. */
export type OpenRowsRecord<F extends FieldSet = FieldSet> = Omit<V1RecordsGetResponse, 'fields'> & {
  fields: Partial<F>;
};

type BaseShape = V1MetaBasesResponse['bases'][number];
type TableShape = V1MetaTablesResponse['tables'][number];
type FieldShape = TableShape['fields'][number];
type ViewShape = TableShape['views'][number];

/** A base the caller can reach, with Airtable's name for their role (`read` … `owner`). */
export interface Base extends BaseShape {}
/** A field: `type` is Airtable's name for its type, `openrowsType` ours. */
export interface Field extends FieldShape {}
/** A view of a table. */
export interface View extends ViewShape {}
/** A table with its fields and views (`primaryFieldId` is its first field). */
export interface TableSchema extends Omit<TableShape, 'fields' | 'views'> {
  fields: Field[];
  views: View[];
}
export type CreateTableInput = V1MetaCreateTableBody;
export type CreateFieldInput = V1MetaCreateFieldBody;
export type UpdateFieldInput = V1MetaUpdateFieldBody;

/** `select()`'s parameters (`offset` is the SDK's to manage). */
export type SelectParams = Omit<V1RecordsListPostBody, 'offset'>;
/** `find()`'s options. */
export type FindOptions = V1RecordsGetQuery;

export interface WriteOptions {
  /** Read values as Airtable's typecast does: new select options, linked records by name. */
  typecast?: boolean;
  /** Answer cells keyed by field id instead of name. */
  returnFieldsByFieldId?: boolean;
}

export interface UpsertOptions extends WriteOptions {
  /** The 1 to 3 fields that match a record without an id to an existing one. */
  fieldsToMergeOn: string[];
}

export interface RecordUpdate<F extends FieldSet = FieldSet> {
  id: string;
  fields: Partial<F>;
}

export interface UpsertResult<F extends FieldSet = FieldSet> {
  records: OpenRowsRecord<F>[];
  /** Ids of the records created. */
  createdRecords: string[];
  /** Ids of the records updated. */
  updatedRecords: string[];
}

type WebhookShape = V1WebhooksListResponse['webhooks'][number];
type DeliveryShape = V1WebhooksDeliveriesResponse['deliveries'][number];

/** A record moved to the trash. */
export interface DeletedRecord extends V1RecordsDeleteResponse {}

/** A comment on a record (`text` is Markdown with `@[Name](user:<id>)` mentions). */
export interface Comment extends V1CommentsCreateResponse {}
/** A page of comments, newest first; `offset` fetches the next one. */
export interface CommentPage extends Omit<V1CommentsListResponse, 'comments'> {
  comments: Comment[];
}

/** A webhook (never with its secret). */
export interface Webhook extends WebhookShape {}
/** A webhook as created or rotated: `secret` is its signing secret, shown only this once. */
export interface WebhookWithSecret extends V1WebhooksCreateResponse {}
export type CreateWebhookInput = V1WebhooksCreateBody;
export type UpdateWebhookInput = V1WebhooksUpdateBody;
/** One delivery attempt of a webhook (or a ping). */
export interface WebhookDelivery extends DeliveryShape {}

/** An automation: its trigger, actions and last run (never its webhook URL). */
export type Automation = V1AutomationsGetResponse;
/** One run of an automation, with its steps' (redacted) inputs and outputs. */
export type AutomationRun = V1AutomationsRunsResponse['runs'][number];
export type AutomationRunStatus = AutomationRun['status'];
/** A queued trigger: the run shows in the history once the worker ran it. */
export type AutomationTriggered = V1AutomationsTriggerResponse;
