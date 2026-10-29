import {
  BRAND,
  MAX_WEBHOOKS_PER_BASE,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
} from '@openrows/shared';
import type { ReactNode } from 'react';

/**
 * The guides of the API reference: authentication, pagination, rate limits, errors, and
 * the "From Airtable" page. Static text; the reference itself comes from the OpenAPI document.
 */

export interface Guide {
  id: string;
  title: string;
  body: ReactNode;
}

export const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-xs bg-hover px-1 font-mono text-small">{children}</code>
);

export const Pre = ({ children, label }: { children: string; label: string }) => (
  <figure
    aria-label={label}
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable code block must be reachable by keyboard
    tabIndex={0}
    className="my-3 overflow-x-auto rounded-sm border border-border bg-app p-3"
  >
    <pre className="font-mono text-small">{children}</pre>
  </figure>
);

const P = ({ children }: { children: ReactNode }) => <p className="my-2">{children}</p>;

function Table({ head, rows, caption }: { head: string[]; rows: ReactNode[][]; caption: string }) {
  return (
    <div className="my-3">
      <table className="w-full border-collapse text-left [overflow-wrap:anywhere]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-small text-text-2">
            {head.map((h) => (
              <th key={h} scope="col" className="py-1.5 pr-4 font-[550]">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static rows
            <tr key={i} className="border-b border-border align-top">
              {row.map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static cells
                <td key={j} className="py-1.5 pr-4">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const GUIDES: Guide[] = [
  {
    id: 'introduction',
    title: 'Introduction',
    body: (
      <>
        <P>
          {BRAND} has a public REST API under <Code>/api/v1</Code> in the shape of Airtable's Web
          API, so scripts and integrations written for Airtable work with few changes. The routes
          the web app itself uses are listed too; everything below is generated from the OpenAPI
          document the server serves at <Code>GET /api/openapi.json</Code>, which you can load into
          any OpenAPI tool or give to an AI assistant.
        </P>
        <P>Requests and answers are JSON. Ids are UUIDs. Times are ISO 8601 in UTC.</P>
      </>
    ),
  },
  {
    id: 'authentication',
    title: 'Authentication',
    body: (
      <>
        <P>
          Create a personal access token in Settings → "Developer: personal access tokens" and send
          it on every request:
        </P>
        <Pre label="Authorization header">{'Authorization: Bearer or_pat_…'}</Pre>
        <P>
          A token can do what its owner can, narrowed to its scopes and to the workspaces or bases
          it was given. Each operation below names the scope it needs. Outside the token's
          workspaces and bases the answer is 404, as for anything you can't see; a missing scope is
          403. Tokens expire (90 days by default) and can be revoked at any time. Account, sharing
          and permission settings need a signed-in session and can't be reached with a token.
        </P>
        <Pre label="Example request">
          {`curl https://app.openrows.io/api/v1/meta/bases \\
  -H "Authorization: Bearer $OPENROWS_TOKEN"`}
        </Pre>
      </>
    ),
  },
  {
    id: 'pagination',
    title: 'Pagination',
    body: (
      <>
        <P>
          Record lists answer at most <Code>pageSize</Code> records (up to 100) and, when there are
          more, an <Code>offset</Code>. Send it back unchanged to get the next page; there is no
          offset on the last page. <Code>maxRecords</Code> caps the total across pages.
        </P>
        <Pre label="Paging through records">
          {`GET /api/v1/{baseId}/{table}?pageSize=100
→ { "records": [...], "offset": "…" }
GET /api/v1/{baseId}/{table}?pageSize=100&offset=…
→ { "records": [...] }`}
        </Pre>
        <P>
          The offset is a cursor over the query's sort order, so records added while you page don't
          shift the pages. Comments page the same way, newest first.
        </P>
      </>
    ),
  },
  {
    id: 'rate-limits',
    title: 'Rate limits',
    body: (
      <>
        <P>
          Limits are token buckets: a bucket holds a burst of requests and refills at a steady rate.
          Each request takes one token from every bucket it counts against, and is refused when any
          is empty. The defaults (a self-hosted server can change them):
        </P>
        <Table
          caption="Rate limit buckets"
          head={['Bucket', 'Rate', 'Burst', 'Counts']}
          rows={[
            ['Per base', '5 requests/s', '10', 'every /api/v1 request on that base, from anyone'],
            [
              'Per token',
              '50 requests/s',
              '100',
              'every request made with a personal access token (signed-in users: on /api/v1)',
            ],
          ]}
        />
        <P>
          Every limited answer carries <Code>RateLimit-Limit</Code>,{' '}
          <Code>RateLimit-Remaining</Code>, <Code>RateLimit-Reset</Code> (seconds until the bucket
          is full) and <Code>RateLimit-Policy</Code> for the bucket closest to empty. A refused
          request is <Code>429</Code> with <Code>Retry-After</Code> in seconds and the bucket in the
          error's <Code>limit</Code> (<Code>base</Code>, <Code>token</Code> or <Code>user</Code>).
          Wait that long and retry; refused requests don't count.
        </P>
        <P>Each token's requests per day are shown in its row of the token list in Settings.</P>
      </>
    ),
  },
  {
    id: 'errors',
    title: 'Errors',
    body: (
      <>
        <P>
          Errors of <Code>/api/v1</Code> are in Airtable's shape, with Airtable's error type where
          one fits and {BRAND}' stable <Code>code</Code>:
        </P>
        <Pre label="A v1 error">
          {`{ "error": { "type": "TOO_MANY_REQUESTS", "message": "…",
             "code": "RATE_LIMITED", "requestId": "…", "limit": "base" } }`}
        </Pre>
        <P>
          Every other route answers RFC 9457 <Code>application/problem+json</Code> with{' '}
          <Code>code</Code> and <Code>requestId</Code>; validation errors list each problem in{' '}
          <Code>errors</Code>. Every response, errors included, has an <Code>X-Request-Id</Code>{' '}
          header: quote it when you report a problem.
        </P>
        <Table
          caption="Error statuses"
          head={['Status', 'Meaning']}
          rows={[
            ['401', 'No credential, or an unknown, expired or revoked token'],
            ['403', 'Your role, the token’s scope or an edit permission doesn’t allow it'],
            ['404', 'No such resource, or you (or the token) can’t see it'],
            ['409', 'Conflicts with the current state'],
            ['413', 'The request is too large'],
            ['422', 'The request failed validation'],
            ['429', 'A rate limit: wait for Retry-After seconds'],
          ]}
        />
      </>
    ),
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    body: (
      <>
        <P>
          A base's creators add webhooks under Webhooks in the base menu, or with{' '}
          <Code>POST /api/v1/bases/{'{baseId}'}/webhooks</Code> (scope <Code>webhook:manage</Code>
          ). Up to {MAX_WEBHOOKS_PER_BASE} per base. Each picks events (records created, updated or
          deleted, form submissions, field and table changes) and, optionally, tables and fields.
          The answer to the creation holds the signing secret (<Code>whsec_…</Code>), shown only
          then; <Code>PATCH</Code> with <Code>{'{ "rotateSecret": true }'}</Code> makes a new one.
          The old one keeps signing for 24 hours (a second <Code>v1</Code> in the signature), so
          accept a request when any <Code>v1</Code> matches;{' '}
          <Code>{'{ "expirePreviousSecret": true }'}</Code> ends that at once.
        </P>
        <P>
          Every delivery is a <Code>POST</Code> of JSON with these headers:
        </P>
        <Table
          caption="Webhook headers"
          head={['Header', 'Value']}
          rows={[
            [
              <Code key="s">{WEBHOOK_SIGNATURE_HEADER}</Code>,
              <>
                <Code>t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</Code>: HMAC-SHA256 with the secret over{' '}
                <Code>t + "." + body</Code>
              </>,
            ],
            [
              <Code key="e">{WEBHOOK_EVENT_ID_HEADER}</Code>,
              'The event id, the same on every retry: ignore ids you already handled',
            ],
            [
              <Code key="t">{WEBHOOK_EVENT_TYPE_HEADER}</Code>,
              'record.updated, form.submitted, ping…',
            ],
          ]}
        />
        <Pre label="A record.updated delivery">
          {`{
  "id": "4b0c…", "type": "record.updated", "timestamp": "2026-10-26T10:00:00.000Z",
  "webhookId": "…", "base": { "id": "…", "name": "Roadmap" },
  "table": { "id": "…", "name": "Tasks" },
  "record": { "id": "…", "before": { "fld-id": "Draft" }, "after": { "fld-id": "Shipped" } },
  "fields": { "fld-id": { "name": "Status", "type": "singleSelect" } },
  "actor": { "id": "…", "name": "Ada" }
}`}
        </Pre>
        <P>
          Verify every request before trusting it: recompute the HMAC over the raw body, compare in
          constant time, and refuse a timestamp more than {WEBHOOK_SIGNATURE_TOLERANCE_SECONDS / 60}{' '}
          minutes from your clock, so a captured request can't be replayed later. In Node:
        </P>
        <Pre label="Verifying a webhook signature in Node">
          {`import { createHmac, timingSafeEqual } from 'node:crypto';

// rawBody: the request body exactly as received (a string), before JSON.parse.
export function verify(secret, header, rawBody, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}`}
        </Pre>
        <P>
          Answer with any 2xx within 10 seconds; redirects aren't followed. Anything else is retried
          7 times with growing delays (about 7 minutes up to 8 hours, ~24 hours in all). A webhook
          that keeps failing for a day is turned off and its creator gets an email; one whose
          creator lost access to the base is turned off too. Payloads only hold what the webhook's
          creator can read. The delivery log keeps every attempt for 7 days.
        </P>
      </>
    ),
  },
  {
    id: 'n8n',
    title: 'n8n',
    body: (
      <>
        <P>
          The <Code>@openrows/n8n-nodes-openrows</Code> community package adds an OpenRows node and
          an OpenRows Trigger to n8n. In a self-hosted n8n, install it under Settings → Community
          nodes → Install, with that package name. It is AGPL-3.0-only, so it isn't an n8n verified
          node and n8n Cloud doesn't offer it.
        </P>
        <Table
          caption="n8n nodes"
          head={['Node', 'What it does', 'Token scopes']}
          rows={[
            [
              BRAND,
              'Records: get, get many (filter by formula, sort, view), search, create, update, create or update (match on up to 3 fields), delete; 10 per request',
              <>
                <Code>schema.bases:read</Code>, <Code>data.records:read</Code>,{' '}
                <Code>data.records:write</Code>
              </>,
            ],
            [
              `${BRAND} Trigger`,
              "Registers a webhook on activation and deletes it on deactivation; refuses deliveries whose signature doesn't verify",
              <>
                <Code>schema.bases:read</Code>, <Code>webhook:manage</Code>
              </>,
            ],
          ]}
        />
        <P>
          The credential is the server's URL and a personal access token. The trigger's webhook URL
          must be reachable from the server: a public <Code>https</Code> URL on port 443, unless a
          self-hosted server allows more with <Code>OUTBOUND_HTTP_*</Code>.
        </P>
      </>
    ),
  },
];

const AIRTABLE_ROWS: [string, string, string][] = [
  ['List bases', 'GET /v0/meta/bases', 'GET /api/v1/meta/bases'],
  [
    'Get base schema',
    'GET /v0/meta/bases/{baseId}/tables',
    'GET /api/v1/meta/bases/{baseId}/tables',
  ],
  [
    'Create table',
    'POST /v0/meta/bases/{baseId}/tables',
    'POST /api/v1/meta/bases/{baseId}/tables',
  ],
  [
    'Create field',
    'POST /v0/meta/bases/{baseId}/tables/{tableId}/fields',
    'POST /api/v1/meta/bases/{baseId}/tables/{tableIdOrName}/fields',
  ],
  [
    'Update field',
    'PATCH /v0/meta/bases/{baseId}/tables/{tableId}/fields/{fieldId}',
    'PATCH /api/v1/meta/bases/{baseId}/tables/{tableIdOrName}/fields/{fieldId}',
  ],
  ['List records', 'GET /v0/{baseId}/{table}', 'GET /api/v1/{baseId}/{tableIdOrName}'],
  [
    'List records (POST)',
    'POST /v0/{baseId}/{table}/listRecords',
    'POST /api/v1/{baseId}/{tableIdOrName}/listRecords',
  ],
  [
    'Get record',
    'GET /v0/{baseId}/{table}/{recordId}',
    'GET /api/v1/{baseId}/{tableIdOrName}/{recordId}',
  ],
  ['Create records', 'POST /v0/{baseId}/{table}', 'POST /api/v1/{baseId}/{tableIdOrName}'],
  [
    'Update / upsert records',
    'PATCH or PUT /v0/{baseId}/{table}',
    'PATCH or PUT /api/v1/{baseId}/{tableIdOrName}',
  ],
  [
    'Update one record',
    'PATCH or PUT /v0/{baseId}/{table}/{recordId}',
    'PATCH or PUT /api/v1/{baseId}/{tableIdOrName}/{recordId}',
  ],
  [
    'Delete records',
    'DELETE /v0/{baseId}/{table}?records[]=…',
    'DELETE /api/v1/{baseId}/{tableIdOrName}?records[]=…',
  ],
  [
    'Delete one record',
    'DELETE /v0/{baseId}/{table}/{recordId}',
    'DELETE /api/v1/{baseId}/{tableIdOrName}/{recordId}',
  ],
  [
    'List / create comments',
    'GET or POST /v0/{baseId}/{table}/{recordId}/comments',
    'GET or POST /api/v1/{baseId}/{tableIdOrName}/{recordId}/comments',
  ],
];

/** The "From Airtable" page: what maps to what, and what differs. */
export const FROM_AIRTABLE: Guide = {
  id: 'from-airtable',
  title: 'From Airtable',
  body: (
    <>
      <P>
        Point Airtable's client at {BRAND} and send a {BRAND} token. The official{' '}
        <Code>airtable</Code> npm client needs <Code>apiVersion: '1.0.0'</Code>, because it builds
        its URLs as <Code>/v&lt;major&gt;/…</Code>:
      </P>
      <Pre label={`Airtable's client against ${BRAND}`}>
        {`import Airtable from 'airtable';

const base = new Airtable({
  apiKey: process.env.OPENROWS_TOKEN,
  endpointUrl: 'https://app.openrows.io/api',
  apiVersion: '1.0.0',
}).base('<base id>');

const done = await base('Projects')
  .select({ filterByFormula: "{Status} = 'Done'" })
  .all();`}
      </Pre>
      <Table
        caption={`Airtable endpoints and their ${BRAND} equivalents`}
        head={['Operation', 'Airtable', BRAND]}
        rows={AIRTABLE_ROWS.map(([what, airtable, ours]) => [
          what,
          <Code key="a">{airtable}</Code>,
          <Code key="o">{ours}</Code>,
        ])}
      />
      <h3 className="mt-5 text-heading font-semibold">Scopes</h3>
      <Table
        caption="Token scopes"
        head={['Airtable scope', `${BRAND} scope`]}
        rows={[
          ['schema.bases:read', 'schema.bases:read'],
          ['schema.bases:write', 'schema.bases:write'],
          ['data.records:read', 'data.records:read'],
          ['data.records:write', 'data.records:write'],
          ['data.recordComments:read / :write', 'data.recordComments:read / :write'],
          ['user.email:read', 'user.email:read'],
        ].map(([a, o]) => [<Code key="a">{a}</Code>, <Code key="o">{o}</Code>])}
      />
      <h3 className="mt-5 text-heading font-semibold">Differences</h3>
      <ul className="my-2 list-disc pl-5">
        <li>
          Ids are UUIDs, without Airtable's <Code>app</Code>/<Code>tbl</Code>/<Code>fld</Code>/
          <Code>rec</Code> prefixes; code that passes ids through works unchanged.
        </li>
        <li>
          Tables are named by id or name, only inside the base in the path. Cells are keyed by field
          name, or by id with <Code>returnFieldsByFieldId</Code>.
        </li>
        <li>
          <Code>filterByFormula</Code> runs as a database query and supports a subset: AND, OR, NOT,
          comparisons of a field with a value, BLANK(), TODAY(), FIND/SEARCH, IS_BEFORE, IS_AFTER,
          IS_SAME and RECORD_ID(). Anything else is 422 <Code>INVALID_FILTER_BY_FORMULA</Code>.
        </li>
        <li>
          Status codes are {BRAND}': 404 for anything outside your access, 422 for validation. Error
          bodies keep Airtable's shape and types.
        </li>
        <li>
          Rate limits match Airtable's 5 requests per second per base, with a burst of 10, and 50
          per second per token; see{' '}
          <a href="/docs/api#rate-limits" className="underline">
            Rate limits
          </a>
          .
        </li>
        <li>
          Attachments can't be written from a URL yet; upload them first. Webhooks aren't available
          yet.
        </li>
      </ul>
    </>
  ),
};

/** The JavaScript SDK page's introduction; its reference comes from TypeDoc. */
export const SDK_GUIDE: Guide = {
  id: 'sdk',
  title: 'JavaScript SDK',
  body: (
    <>
      <P>
        <Code>@openrows/sdk</Code> is a typed client for the REST API v1, for Node 20+ and browsers,
        ESM and CommonJS, with no dependencies beyond <Code>fetch</Code>. Its types are generated
        from the API's contracts. Writes of more than 10 records go 10 per request, pages are
        followed for you, a <Code>429</Code> is retried after its <Code>Retry-After</Code>, and
        every refusal throws an <Code>OpenRowsError</Code> with its <Code>status</Code>,{' '}
        <Code>type</Code>, <Code>code</Code> and <Code>requestId</Code>.
      </P>
      <Pre label="Install the SDK">{'npm install @openrows/sdk'}</Pre>
      <Pre label="Read and write records with the SDK">
        {`import { OpenRows } from '@openrows/sdk';

const openrows = new OpenRows({
  apiKey: process.env.OPENROWS_TOKEN, // or_pat_…
  baseUrl: 'https://app.openrows.io',
});

const tasks = openrows.table('<base id>', 'Tasks');
const done = await tasks
  .select({ filterByFormula: "{Status} = 'Done'", sort: [{ field: 'Name' }] })
  .all();

await tasks.create([{ fields: { Name: 'Ship it' } }], { typecast: true });
await tasks.update(done[0].id, { Status: 'Archived' });
await tasks.destroy(done.map((r) => r.id));`}
      </Pre>
      <P>
        Comments (<Code>tasks.comments(recordId)</Code>), schema (
        <Code>openrows.tables(baseId)</Code>, <Code>tasks.fields</Code>) and webhooks (
        <Code>openrows.webhooks(baseId)</Code>) work the same way. The reference below lists every
        export.
      </P>
    </>
  ),
};

/** The MCP server's tools, and the token scope each needs. */
export const MCP_TOOLS: [name: string, what: string, scope: string][] = [
  ['list_bases', 'The bases the token reaches, with your permission level', 'schema.bases:read'],
  ['describe_base', "A base's tables, fields (types, options) and views", 'schema.bases:read'],
  [
    'list_records',
    'Records a page at a time (limit up to 100, offset): filterByFormula, search, sort, view, fields',
    'data.records:read',
  ],
  ['get_record', 'One record by id', 'data.records:read'],
  ['create_records', 'Creates 1 to 10 records (typecast optional)', 'data.records:write'],
  ['update_records', 'Changes the given cells of 1 to 10 records', 'data.records:write'],
  [
    'delete_records',
    "Moves 1 to 10 records to the base's trash (marked destructive)",
    'data.records:write',
  ],
  ['add_comment', 'Comments on a record, @mentions included', 'data.recordComments:write'],
];

/**
 * The MCP server's page, with this server's own URL in the snippets (`origin`), so a
 * self-hosted install shows its own.
 */
export function mcpGuide(origin: string): Guide {
  const token = 'or_pat_…';
  return {
    id: 'mcp',
    title: 'MCP server (AI agents)',
    body: (
      <>
        <P>
          AI agents such as Claude Code and Cursor use {BRAND} through the Model Context Protocol:
          they list your bases, read a base's schema, list, search and read records, create, update
          and delete them, and comment. The tools call the REST API v1 with one personal access
          token, so an agent can do only what the token's scopes, its grants and your role allow,
          under the same rate limits. Create a token in Settings → "Developer: personal access
          tokens", for one agent, with the fewest scopes that do the job:{' '}
          <Code>schema.bases:read</Code> and <Code>data.records:read</Code> to read;{' '}
          <Code>data.records:write</Code> and <Code>data.recordComments:write</Code> to write too.
        </P>
        <Table
          caption="MCP tools"
          head={['Tool', 'What it does', 'Scope']}
          rows={MCP_TOOLS.map(([name, what, scope]) => [
            <Code key="n">{name}</Code>,
            what,
            <Code key="s">{scope}</Code>,
          ])}
        />
        <h3 className="mt-6 mb-1 font-semibold">Remote server (nothing to install)</h3>
        <P>
          The server answers MCP over Streamable HTTP at <Code>{`${origin}/mcp`}</Code>, with the
          token as a bearer header. It offers only the tools the token's scopes allow.
        </P>
        <Pre label="Claude Code: add the remote server">
          {`claude mcp add --transport http openrows ${origin}/mcp \\
  --header "Authorization: Bearer ${token}"`}
        </Pre>
        <Pre label="Cursor: ~/.cursor/mcp.json, remote server">
          {JSON.stringify(
            {
              mcpServers: {
                openrows: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${token}` } },
              },
            },
            null,
            2
          )}
        </Pre>
        <h3 className="mt-6 mb-1 font-semibold">Local server (stdio)</h3>
        <P>
          <Code>@openrows/mcp-server</Code> runs on your machine, started by the client, with the
          token in its environment (<Code>OPENROWS_API_KEY</Code>) and your server's URL (
          <Code>OPENROWS_URL</Code>, default <Code>https://app.openrows.io</Code>). It offers every
          tool; the API refuses what the token can't do. <Code>npx -y @openrows/mcp-server</Code>{' '}
          fetches it from npm (Node 20 or later); <Code>--help</Code> lists its settings.
        </P>
        <Pre label="Claude Code: add the local server">
          {`claude mcp add openrows \\
  --env OPENROWS_API_KEY=${token} --env OPENROWS_URL=${origin} \\
  -- npx -y @openrows/mcp-server`}
        </Pre>
        <Pre label="Cursor: ~/.cursor/mcp.json, local server">
          {JSON.stringify(
            {
              mcpServers: {
                openrows: {
                  command: 'npx',
                  args: ['-y', '@openrows/mcp-server'],
                  env: { OPENROWS_API_KEY: token, OPENROWS_URL: origin },
                },
              },
            },
            null,
            2
          )}
        </Pre>
        <h3 className="mt-6 mb-1 font-semibold">Limits and safety</h3>
        <P>
          Writes take up to 10 records a call and pages up to 100 records; answers are cut to
          100,000 characters (long texts first, then records, saying so). Deleted records go to the
          base's trash for 30 days. Agents are told that cell values and comments are data, never
          instructions, and to confirm deletions with you. Keep the token in the client's settings,
          never in a chat; revoke it in Settings when the agent no longer needs it. Agents can also
          read <Code>{`${origin}/llms.txt`}</Code>, an index of these docs.
        </P>
      </>
    ),
  };
}
