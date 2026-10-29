import { describe, expect, it } from 'vitest';
import { FIXTURE_BASE_ID, FIXTURE_TOKEN, fakeAirtable } from './__fixtures__/fake.js';
import { createAirtableClient } from './client.js';

const instant = async () => {};

describe('Airtable client', () => {
  it('reads bases, the schema and paged records from api.airtable.com only', async () => {
    const fake = fakeAirtable({ pageSize: 100 });
    const client = createAirtableClient(FIXTURE_TOKEN, { http: fake.http, sleep: instant });
    expect((await client.listBases()).map((b) => b.id)).toContain(FIXTURE_BASE_ID);
    const tables = await client.tables(FIXTURE_BASE_ID);
    const tasks = tables[1];
    if (!tasks) throw new Error('no tasks');
    const first = await client.records(FIXTURE_BASE_ID, tasks.id);
    expect(first.records).toHaveLength(100);
    const second = await client.records(FIXTURE_BASE_ID, tasks.id, first.offset);
    expect(second.records).toHaveLength(50);
    expect(second.offset).toBeUndefined();
    for (const r of fake.requests) {
      expect(new URL(r.url).origin).toBe('https://api.airtable.com');
      expect(r.authorization).toBe(`Bearer ${FIXTURE_TOKEN}`);
    }
    expect(fake.requests.at(-1)?.url).toContain('returnFieldsByFieldId=true');
  });

  it('refuses ids that would leave the API paths', async () => {
    const client = createAirtableClient(FIXTURE_TOKEN, { http: fakeAirtable().http });
    await expect(client.tables('../../evil.example')).rejects.toThrow('bad base id');
    await expect(client.records(FIXTURE_BASE_ID, 'tbl/../x')).rejects.toThrow();
  });

  it('turns refusals into messages without the token', async () => {
    const wrong = `patNotTheToken001.${'b'.repeat(64)}`;
    const client = createAirtableClient(wrong, { http: fakeAirtable().http, sleep: instant });
    const err: unknown = await client.listBases().then(
      () => null,
      (e: unknown) => e
    );
    expect(JSON.stringify(err)).not.toContain(wrong);
    expect(String(err)).not.toContain(wrong);
    expect((err as { detail?: string }).detail).toContain('Airtable rejected the token');
    const forbidden = createAirtableClient(FIXTURE_TOKEN, {
      http: fakeAirtable().http,
      sleep: instant,
    });
    await expect(forbidden.tables('appOtherBase00001')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const down = fakeAirtable();
    down.failWith(503);
    await expect(
      createAirtableClient(FIXTURE_TOKEN, { http: down.http, sleep: instant }).listBases()
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('waits 30 s on a 429, up to three times', async () => {
    const fake = fakeAirtable();
    const waits: number[] = [];
    let clock = 0;
    const client = createAirtableClient(FIXTURE_TOKEN, {
      http: fake.http,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    fake.rateLimitNext(2);
    await client.listBases();
    expect(waits.filter((w) => w === 30_000)).toHaveLength(2);
    fake.rateLimitNext(10);
    await expect(client.listBases()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('spaces requests 200 ms apart', async () => {
    const fake = fakeAirtable();
    let clock = 1000;
    const waits: number[] = [];
    const client = createAirtableClient(FIXTURE_TOKEN, {
      http: fake.http,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    for (let i = 0; i < 4; i++) await client.listBases();
    expect(waits).toEqual([200, 200, 200]);
  });
});
