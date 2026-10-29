import {
  type IDataObject,
  type IHookFunctions,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';
import { baseLocator } from './description';
import { listSearch, loadOptions } from './methods';
import { isPayload, simplifyPayload } from './payload';
import { verifySignature } from './signature';
import { apiRequest, CREDENTIALS, seg } from './transport';

/** The events a webhook can send; `ping` is answered, never a run. */
export const TRIGGER_EVENTS = [
  { name: 'Record Created', value: 'record.created' },
  { name: 'Record Updated', value: 'record.updated' },
  { name: 'Record Deleted', value: 'record.deleted' },
  { name: 'Form Submitted', value: 'form.submitted' },
  { name: 'Field Created', value: 'field.created' },
  { name: 'Field Updated', value: 'field.updated' },
  { name: 'Field Deleted', value: 'field.deleted' },
  { name: 'Table Created', value: 'table.created' },
  { name: 'Table Updated', value: 'table.updated' },
  { name: 'Table Deleted', value: 'table.deleted' },
] as const;

const EVENT_VALUES = new Set<string>(TRIGGER_EVENTS.map((e) => e.value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The longest webhook description OpenRows keeps. */
const MAX_DESCRIPTION = 200;

/** What the trigger remembers about the webhook it registered (workflow static data). */
interface HookState extends IDataObject {
  webhookId?: string;
  baseId?: string;
  secret?: string;
}

interface ApiWebhook {
  id: string;
  url: string;
  enabled: boolean;
  secret?: string;
}

const isNotFound = (error: unknown) => error instanceof NodeApiError && error.httpCode === '404';

function forget(state: HookState) {
  delete state.webhookId;
  delete state.baseId;
  delete state.secret;
}

/**
 * Starts a workflow on a base's changes: registers an OpenRows webhook pointing at n8n's
 * webhook URL when the workflow is activated, deletes it when deactivated, and refuses every
 * delivery whose `X-OpenRows-Signature` doesn't verify with the webhook's secret.
 */
export class OpenRowsTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'OpenRows Trigger',
    name: 'openRowsTrigger',
    icon: 'file:openrows.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["events"].join(", ")}}',
    description: 'Starts the workflow when records, fields or tables of an OpenRows base change',
    defaults: { name: 'OpenRows Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIALS, required: true }],
    webhooks: [
      { name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' },
    ],
    properties: [
      {
        displayName:
          'OpenRows only delivers to public https URLs (port 443) unless the server allows more (OUTBOUND_HTTP_* on a self-hosted server). The token needs the webhook:manage scope.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      baseLocator,
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        required: true,
        options: [...TRIGGER_EVENTS],
        default: ['record.created', 'record.updated'],
      },
      {
        displayName: 'Table Names or IDs',
        name: 'tableIds',
        type: 'multiOptions',
        default: [],
        typeOptions: { loadOptionsMethod: 'getTables', loadOptionsDependsOn: ['base.value'] },
        description:
          'Only these tables\' events (none: every table, including new ones). Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Simplify',
        name: 'simplify',
        type: 'boolean',
        default: true,
        description:
          'Whether to return cells by field name (fields, previousFields, changedFields) instead of the raw payload, keyed by field ID',
      },
    ],
  };

  methods = { listSearch, loadOptions };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const state = this.getWorkflowStaticData('node') as HookState;
        if (!state.webhookId || !state.baseId || !state.secret) return false;
        const url = this.getNodeWebhookUrl('default');
        let hooks: ApiWebhook[];
        try {
          ({ webhooks: hooks } = await apiRequest<{ webhooks: ApiWebhook[] }>(
            this,
            'GET',
            `/bases/${seg(state.baseId)}/webhooks`
          ));
        } catch (error) {
          if (!isNotFound(error)) throw error;
          hooks = [];
        }
        const found = hooks.find((h) => h.id === state.webhookId);
        if (found && found.url === url) {
          if (found.enabled) return true;
          // Turned off by the server (failures, lost access): replaced by a new one.
          await apiRequest(this, 'DELETE', `/bases/${seg(state.baseId)}/webhooks/${seg(found.id)}`);
        }
        // Gone, or registered for another URL (the production one while the editor listens for a
        // test event, whose static data n8n doesn't keep): left alone, a new one is registered.
        forget(state);
        return false;
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const url = this.getNodeWebhookUrl('default');
        if (!url) throw new NodeOperationError(this.getNode(), 'n8n gave no webhook URL');
        const baseId = String(this.getNodeParameter('base', '', { extractValue: true })).trim();
        if (!UUID.test(baseId)) {
          throw new NodeOperationError(this.getNode(), 'Pick a base (or enter its ID)');
        }
        const events = (this.getNodeParameter('events', []) as string[]).filter((e) =>
          EVENT_VALUES.has(e)
        );
        if (!events.length) throw new NodeOperationError(this.getNode(), 'Pick at least one event');
        const tableIds = (this.getNodeParameter('tableIds', []) as string[]).filter(Boolean);
        const bad = tableIds.find((id) => !UUID.test(id));
        if (bad) {
          throw new NodeOperationError(this.getNode(), `"${bad.slice(0, 64)}" is not a table ID`);
        }
        const name = this.getWorkflow().name ?? '';
        const hook = await apiRequest<ApiWebhook>(this, 'POST', `/bases/${seg(baseId)}/webhooks`, {
          body: {
            url,
            description: `n8n: ${name}`.trim().slice(0, MAX_DESCRIPTION),
            events,
            tableIds: tableIds.length ? tableIds : null,
          },
        });
        if (!hook.secret) {
          throw new NodeOperationError(this.getNode(), 'OpenRows returned no signing secret');
        }
        const state = this.getWorkflowStaticData('node') as HookState;
        state.webhookId = hook.id;
        state.baseId = baseId;
        state.secret = hook.secret;
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const state = this.getWorkflowStaticData('node') as HookState;
        if (state.webhookId && state.baseId) {
          try {
            await apiRequest(
              this,
              'DELETE',
              `/bases/${seg(state.baseId)}/webhooks/${seg(state.webhookId)}`
            );
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
        }
        forget(state);
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const state = this.getWorkflowStaticData('node') as HookState;
    const req = this.getRequestObject() as { rawBody?: Buffer };
    const header = this.getHeaderData()['x-openrows-signature'];
    const raw = req.rawBody;
    const refuse = (status: number, message: string): IWebhookResponseData => {
      this.getResponseObject().status(status).send(message);
      return { noWebhookResponse: true };
    };
    if (
      !raw ||
      !verifySignature(state.secret ?? '', typeof header === 'string' ? header : undefined, raw)
    ) {
      return refuse(401, 'Invalid signature');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return refuse(400, 'Invalid JSON');
    }
    if (!isPayload(payload)) return refuse(400, 'Not an OpenRows event');
    // A test from the webhook's menu: answered, without starting the workflow.
    if (payload.type === 'ping') return { webhookResponse: 'OK' };
    const simplify = this.getNodeParameter('simplify', true) as boolean;
    const json = simplify ? simplifyPayload(payload) : (payload as unknown as IDataObject);
    return { workflowData: [[{ json }]] };
  }
}
