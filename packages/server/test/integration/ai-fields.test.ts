import type { AiFieldStatus, FieldMeta, RecordData, TableMeta } from '@openrows/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  completion,
  type FakeOpenAi,
  type FakeRequest,
  fakeOutbound,
  startFakeOpenAi,
} from '../../src/ai/__fixtures__/fake-openai.js';
import {
  AI_DEBOUNCE_SECONDS,
  AI_FIELD_QUEUE,
  aiFieldSubscriber,
  runAiFieldJob,
} from '../../src/ai/fields/generate.js';
import { AiService } from '../../src/ai/service.js';
import { createCipher } from '../../src/auth/crypto.js';
import { SESSION_COOKIE } from '../../src/auth/session-token.js';
import type { AiConfig } from '../../src/config.js';
import { aiFieldCells, outbox, workspaceMembers } from '../../src/db/index.js';
import { ossEdition, ossEntitlements } from '../../src/edition/index.js';
import type { Edition, UsageMeter } from '../../src/edition/types.js';
import { relayOutbox } from '../../src/jobs/relay.js';
import { createLogger } from '../../src/lib/logger.js';
import { testApp } from '../helpers/app.js';
import { useTestDb } from '../helpers/db.js';
import { addMember, createSession, createWorkspace } from '../helpers/factories.js';

/**
 * AI fields end to end against real Postgres and a fake OpenAI-compatible provider whose
 * answers are scripted from the prompt (deterministic): the backfill of a new field, select
 * answers always one of the options, regeneration when a referenced field changes (debounced
 * through the outbox), manual regenerate and cancel, and the AI credits running out without
 * deleting any value.
 */
const t = useTestDb();
const logger = createLogger({ level: 'silent' });
const ENCRYPTION_KEY = 'ai-fields-test-encryption-key-0123456789';

let fake: FakeOpenAi;
/** The instance's AI credits: exhausted when false. */
let credits = true;
const usage: UsageMeter = {
  id: 'test',
  record: async () => {},
  check: async () =>
    credits ? { allowed: true } : { allowed: false, metric: 'aiCredits', used: 10, limit: 10 },
};

let aiConfig: AiConfig;
let ai: AiService;
let app: ReturnType<typeof testApp>;

const userPrompt = (req: FakeRequest) => {
  const messages = req.body['messages'] as { role: string; content: string }[];
  return messages.find((m) => m.role === 'user')?.content ?? '';
};
const schemaName = (req: FakeRequest) =>
  (req.body['response_format'] as { json_schema?: { name?: string } } | undefined)?.json_schema
    ?.name;

/** The scripted model: a choice from the notes, the notes' length, a summary echo. */
function answer(req: FakeRequest) {
  const prompt = userPrompt(req);
  const name = schemaName(req);
  if (name === 'choice_answer') {
    if (prompt.includes('crash')) return completion('{"choice":"bug"}');
    if (prompt.includes('idea')) return completion('{"choice":"Feature"}');
    return completion('{"choice":"Question"}');
  }
  if (name === 'number_answer') return completion(`{"value":${prompt.length}}`);
  return completion(`Summary: ${prompt}`);
}

beforeAll(async () => {
  fake = await startFakeOpenAi();
  aiConfig = {
    instance: { baseUrl: fake.baseUrl, model: 'fake-model', apiKey: 'sk-test-instance-0123456789' },
    allowedHosts: undefined,
    timeoutMs: 10_000,
  };
  const edition: Edition = { ...ossEdition(), usage };
  app = testApp({
    db: t.appDb,
    edition,
    config: { encryptionKey: ENCRYPTION_KEY, outbound: fakeOutbound(fake.port), ai: aiConfig },
  });
  ai = new AiService({
    config: aiConfig,
    outbound: fakeOutbound(fake.port),
    cipher: createCipher(ENCRYPTION_KEY, 'ai-key'),
    usage,
    entitlements: ossEntitlements,
    db: t.appDb,
    logger,
  });
});
afterAll(() => fake.close());
beforeEach(() => {
  credits = true;
  fake.requests.length = 0;
  fake.respond = answer;
});

async function ok<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

function client(cookie: string) {
  return (method: string, path: string, body?: unknown) =>
    app.app.request(path, {
      method,
      headers: {
        origin: app.config.appUrl,
        cookie: `${SESSION_COOKIE}=${cookie}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

/** Relays the outbox to `ai.generate` and runs its jobs until no AI cell is pending. */
async function drainAi(): Promise<{ jobs: { singletonKey?: string; startAfter?: unknown }[] }> {
  const seen: { singletonKey?: string; startAfter?: unknown }[] = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const jobs: { data: unknown; singletonKey?: string; startAfter?: unknown }[] = [];
    const relayed = await relayOutbox(
      t.appDb,
      async (queue, inserted) => {
        if (queue === AI_FIELD_QUEUE) {
          for (const j of inserted) {
            jobs.push({ data: j.data, singletonKey: j.singletonKey, startAfter: j.startAfter });
          }
        }
      },
      [aiFieldSubscriber]
    );
    for (const job of jobs) {
      seen.push({ singletonKey: job.singletonKey, startAfter: job.startAfter });
      await runAiFieldJob({ db: t.appDb, ai, logger, intervalMs: 0 }, job.data);
    }
    if (jobs.length || relayed.events) continue;
    const { rows } = await t.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM ai_field_cells WHERE status = 'pending'`
    );
    if (Number(rows[0]?.n ?? 0) === 0) return { jobs: seen };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('drainAi: cells still pending after 30 s');
}

describe('AI fields', () => {
  let owner: string;
  let editor: string;
  let editorId: string;
  let workspaceId: string;
  let request: ReturnType<typeof client>;
  let table: TableMeta;
  let notes: FieldMeta;
  let records: RecordData[];

  const primaryOf = (tbl: TableMeta) => tbl.fields.find((f) => f.isPrimary)?.id as string;
  const field = (name: string, type: string, options: unknown) =>
    request('POST', `/api/tables/${table.id}/fields`, { name, type, options });
  const values = async (fieldId: string) => {
    const list = await ok<{ records: RecordData[] }>(
      request('GET', `/api/tables/${table.id}/records?limit=100`)
    );
    return list.records.map((r) => r.fields[fieldId] ?? null);
  };
  const status = (fieldId: string, as = request) =>
    ok<AiFieldStatus>(as('GET', `/api/fields/${fieldId}/ai`));

  beforeAll(async () => {
    const w = await createWorkspace(t.db);
    workspaceId = w.workspace.id;
    owner = await createSession(t.db, w.owner);
    const ed = await addMember(t.db, workspaceId, 'editor');
    editorId = ed.id;
    editor = await createSession(t.db, ed);
    request = client(owner);
    const base = await ok<{ id: string }>(
      request('POST', `/api/workspaces/${workspaceId}/bases`, { name: 'Support' }),
      201
    );
    table = await ok<TableMeta>(
      request('POST', `/api/bases/${base.id}/tables`, { name: 'Tickets' }),
      201
    );
    // A new table comes with a Notes field.
    notes =
      table.fields.find((f) => f.name === 'Notes') ??
      (await ok<FieldMeta>(field('Notes', 'longText', {}), 201));
    const created = await ok<{ records: RecordData[] }>(
      request('POST', `/api/tables/${table.id}/records`, {
        records: [
          { fields: { [primaryOf(table)]: 'A', [notes.id]: 'The app crash on save' } },
          { fields: { [primaryOf(table)]: 'B', [notes.id]: 'An idea for dark mode' } },
          { fields: { [primaryOf(table)]: 'C', [notes.id]: 'How do I export?' } },
          { fields: { [primaryOf(table)]: 'D' } },
        ],
      }),
      201
    );
    records = created.records;
    await drainAi();
  });

  it('checks the prompt: fields by name, stored by id; no unknown fields, no AI inputs', async () => {
    const bad = await field('Bad', 'ai', { prompt: 'Use {Nope}' });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain('No field named');
    const noChoices = await field('Kind', 'ai', { prompt: '{Notes}', output: 'singleSelect' });
    expect(noChoices.status).toBe(422);
    const first = await ok<FieldMeta>(field('Echo', 'ai', { prompt: 'Say {notes}' }), 201);
    expect(first.options).toMatchObject({
      prompt: `Say {${notes.id}}`,
      referencedFieldIds: [notes.id],
    });
    const chained = await field('Chained', 'ai', { prompt: 'Rewrite {Echo}' });
    expect(chained.status).toBe(422);
    expect(await chained.text()).toContain('AI field');
    // A formula reading an AI field can't feed a prompt either.
    await ok<FieldMeta>(field('Echo length', 'formula', { formula: 'LEN({Echo})' }), 201);
    expect((await field('Via formula', 'ai', { prompt: '{Echo length}' })).status).toBe(422);
    await drainAi();
  });

  it('backfills a new field; a select answer is always one of the options', async () => {
    fake.requests.length = 0;
    const category = await ok<FieldMeta>(
      field('Category', 'ai', {
        prompt: 'Classify: {Notes}',
        output: 'singleSelect',
        choices: [
          { id: 'bug', name: 'Bug', color: 'red' },
          { id: 'feature', name: 'Feature', color: 'green' },
        ],
      }),
      201
    );
    const pending = await status(category.id);
    expect(pending.counts.pending).toBe(4);
    const { jobs } = await drainAi();
    expect(jobs[0]).toMatchObject({
      singletonKey: `ai:${table.id}`,
      startAfter: AI_DEBOUNCE_SECONDS,
    });
    // D has no notes: no request, an empty cell.
    expect(fake.requests).toHaveLength(3);
    expect(userPrompt(fake.requests[0] as FakeRequest)).toBe('Classify: The app crash on save');
    // "bug" maps to the Bug option; "Question" isn't an option: empty, with an error.
    expect(await values(category.id)).toEqual(['Bug', 'Feature', null, null]);
    const after = await status(category.id);
    expect(after.counts).toEqual({ pending: 0, done: 3, error: 1, canceled: 0 });
    expect(after.cells).toEqual([
      expect.objectContaining({
        recordId: records[2]?.id,
        status: 'error',
        error: expect.stringContaining("isn't one of the options"),
      }),
    ]);
    // Renaming a choice renames the stored answers.
    const renamed = await ok<FieldMeta>(
      request('PATCH', `/api/fields/${category.id}`, {
        options: {
          ...(category.options as object),
          prompt: 'Classify: {Notes}',
          choices: [
            { id: 'bug', name: 'Defect', color: 'red' },
            { id: 'feature', name: 'Feature', color: 'green' },
          ],
        },
      })
    );
    expect(renamed.options).toMatchObject({ prompt: `Classify: {${notes.id}}` });
    expect(await values(category.id)).toEqual(['Defect', 'Feature', null, null]);
    expect((await status(category.id)).counts.pending).toBe(0);
  });

  it('asks again when a referenced field changes, not for other fields', async () => {
    const score = await ok<FieldMeta>(
      field('Length', 'ai', { prompt: '{Notes}', output: 'number' }),
      201
    );
    await drainAi();
    expect(await values(score.id)).toEqual([21, 21, 16, null]);
    // A field the prompt doesn't read: nothing to do.
    await ok(
      request('PATCH', `/api/tables/${table.id}/records`, {
        records: [{ id: records[0]?.id, fields: { [primaryOf(table)]: 'A2' } }],
      })
    );
    const [cell] = await t.db
      .select()
      .from(aiFieldCells)
      .where(
        and(eq(aiFieldCells.fieldId, score.id), eq(aiFieldCells.recordId, records[0]?.id ?? ''))
      );
    expect(cell?.status).toBe('done');
    // The notes: the cell is pending, one `ai.requested` event wakes the worker.
    const before = await t.db.select({ id: outbox.id }).from(outbox);
    const last = Math.max(...before.map((r) => Number(r.id)));
    await ok(
      request('PATCH', `/api/tables/${table.id}/records`, {
        records: [{ id: records[0]?.id, fields: { [notes.id]: 'Short' } }],
      })
    );
    expect((await status(score.id)).cells).toEqual([
      expect.objectContaining({ recordId: records[0]?.id, status: 'pending' }),
    ]);
    const events = await t.db
      .select({ kind: outbox.kind })
      .from(outbox)
      .where(sql`${outbox.id} > ${last} AND ${outbox.kind} = 'ai.requested'`);
    expect(events).toHaveLength(1);
    await drainAi();
    expect((await values(score.id))[0]).toBe(5);
  });

  it('regenerates and cancels on request: editors name records, creators the whole field', async () => {
    const summary = await ok<FieldMeta>(
      field('Summary', 'ai', { prompt: 'Sum up {Notes}', output: 'summary' }),
      201
    );
    await drainAi();
    expect((await values(summary.id))[1]).toBe('Summary: Sum up An idea for dark mode');
    const asEditor = client(editor);
    expect(
      (await asEditor('POST', `/api/fields/${summary.id}/ai/generate`, { scope: 'all' })).status
    ).toBe(403);
    expect(
      await ok(
        asEditor('POST', `/api/fields/${summary.id}/ai/generate`, { recordIds: [records[1]?.id] })
      )
    ).toEqual({ queued: 1 });
    expect(
      (
        await asEditor('POST', `/api/fields/${summary.id}/ai/generate`, {
          recordIds: ['01900000-0000-7000-8000-000000000999'],
        })
      ).status
    ).toBe(404);
    expect(
      await ok(request('POST', `/api/fields/${summary.id}/ai/generate`, { scope: 'all' }))
    ).toEqual({ queued: 4 });
    expect(await ok(asEditor('POST', `/api/fields/${summary.id}/ai/cancel`))).toEqual({
      canceled: 4,
    });
    fake.requests.length = 0;
    await drainAi();
    expect(fake.requests).toHaveLength(0);
    expect((await status(summary.id)).counts).toMatchObject({ pending: 0, canceled: 4 });
    // Values are kept.
    expect((await values(summary.id))[1]).toBe('Summary: Sum up An idea for dark mode');
    // `missing`: the canceled ones (and empty ones) again.
    expect(
      await ok(request('POST', `/api/fields/${summary.id}/ai/generate`, { scope: 'missing' }))
    ).toEqual({ queued: 4 });
    await drainAi();
    expect((await status(summary.id)).counts).toMatchObject({ pending: 0, done: 4 });
    expect(editorId).toBeTruthy();
  });

  it('keeps every value when the AI credits run out', async () => {
    const tag = await ok<FieldMeta>(field('Tag', 'ai', { prompt: 'Tag {Notes}' }), 201);
    await drainAi();
    const kept = await values(tag.id);
    expect(kept.filter((v) => v !== null)).toHaveLength(3);
    credits = false;
    fake.requests.length = 0;
    await ok(request('POST', `/api/fields/${tag.id}/ai/generate`, { scope: 'all' }));
    // A referenced field changing while the credits are gone: the old answer stays too.
    await ok(
      request('PATCH', `/api/tables/${table.id}/records`, {
        records: [{ id: records[1]?.id, fields: { [notes.id]: 'Another idea' } }],
      })
    );
    await drainAi();
    expect(fake.requests).toHaveLength(0);
    expect(await values(tag.id)).toEqual(kept);
    const s = await status(tag.id);
    expect(s.counts.pending).toBe(0);
    expect(s.cells.filter((c) => c.status === 'error').length).toBeGreaterThanOrEqual(3);
    expect(s.cells[0]?.error).toMatch(/credits/);
  });

  it("fails the cells, values kept, when the field's creator has lost access", async () => {
    const other = await addMember(t.db, workspaceId, 'creator');
    const asCreator = client(await createSession(t.db, other));
    const theirs = await ok<FieldMeta>(
      asCreator('POST', `/api/tables/${table.id}/fields`, {
        name: 'Theirs',
        type: 'ai',
        options: { prompt: 'Echo {Notes}' },
      }),
      201
    );
    await drainAi();
    const kept = await values(theirs.id);
    await t.db
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, other.id))
      );
    fake.requests.length = 0;
    await ok(request('POST', `/api/fields/${theirs.id}/ai/generate`, { scope: 'all' }));
    await drainAi();
    expect(fake.requests).toHaveLength(0);
    expect(await values(theirs.id)).toEqual(kept);
    expect((await status(theirs.id)).cells[0]?.error).toMatch(/no longer has access/);
  });

  it('duplicates a table with its AI fields: prompts on the copy, answers copied, none asked', async () => {
    fake.requests.length = 0;
    const copy = await ok<TableMeta>(
      request('POST', `/api/tables/${table.id}/duplicate`, { includeRecords: true }),
      201
    );
    const copyNotes = copy.fields.find((f) => f.name === 'Notes');
    const copyLength = copy.fields.find((f) => f.name === 'Length');
    expect(copyLength?.options).toMatchObject({ prompt: `{${copyNotes?.id}}` });
    await drainAi();
    expect(fake.requests).toHaveLength(0);
    const list = await ok<{ records: RecordData[] }>(
      request('GET', `/api/tables/${copy.id}/records?limit=100`)
    );
    const source = await ok<TableMeta>(request('GET', `/api/tables/${table.id}`));
    const sourceLength = source.fields.find((f) => f.name === 'Length')?.id ?? '';
    expect(list.records.map((r) => r.fields[copyLength?.id ?? ''] ?? null)).toEqual([
      5,
      21,
      16,
      null,
    ]);
    expect(await values(sourceLength)).toEqual([5, 21, 16, null]);
  });
});
