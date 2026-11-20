import { describe, expect, it } from 'vitest';
import { createHostCheck, outboundPolicy, type SafeFetch } from '../../lib/safe-fetch/index.js';
import { csvLabel, csvTableName, readCsv, streamCsv } from './csv.js';
import {
  checkedQuery,
  parseConnectionString,
  postgresLabel,
  postgresProblem,
  quotedTable,
  readPostgres,
} from './postgres.js';
import { columnNames, SourceError, TooManyRows } from './types.js';

/** A SafeFetch answering one canned response, recording the request's headers. */
function fakeHttp(
  answer: { status?: number; body?: string; headers?: Record<string, string> },
  seen: Record<string, string>[] = []
): SafeFetch {
  return async (url, init = {}) => {
    seen.push({ ...(init.headers ?? {}) });
    const body = Buffer.from(answer.body ?? '');
    return {
      status: answer.status ?? 200,
      statusText: '',
      headers: new Headers(answer.headers ?? { 'content-type': 'text/csv' }),
      url: String(url),
      redirected: false,
      body,
      text: () => body.toString('utf8'),
    };
  };
}

/**
 * A SafeFetch that streams like the real one: the head goes to `stream`, then the body in
 * `chunk`-byte pieces to its sink (awaited). Records how many pieces were sent.
 */
function streamingHttp(
  answer: { status?: number; body: string; headers?: Record<string, string> },
  chunk = 7
) {
  const sent = { pieces: 0 };
  const http: SafeFetch = async (url, init = {}) => {
    const status = answer.status ?? 200;
    const headers = new Headers(answer.headers ?? { 'content-type': 'text/csv' });
    const sink = init.stream?.({ status, headers });
    const body = Buffer.from(answer.body);
    if (sink) {
      for (let i = 0; i < body.length; i += chunk) {
        sent.pieces++;
        await sink(body.subarray(i, i + chunk));
      }
    }
    const kept = sink ? Buffer.alloc(0) : body;
    return {
      status,
      statusText: '',
      headers,
      url: String(url),
      redirected: false,
      body: kept,
      text: () => kept.toString('utf8'),
    };
  };
  return { http, sent };
}

describe('CSV sources, streamed', () => {
  const csv = `id,Name\n${Array.from({ length: 1201 }, (_, i) => `${i + 1},"Name\n${i + 1}"`).join('\n')}\n`;

  it('parses the file as it downloads and hands the rows on in pages', async () => {
    const { http } = streamingHttp({
      body: csv,
      headers: { 'content-type': 'text/csv', etag: '"e"' },
    });
    const pages: (string | null)[][][] = [];
    const read = await streamCsv(http, 'https://x/a.csv', {
      maxRows: 1201,
      onRows: async (rows) => {
        pages.push(rows);
      },
    });
    expect(read).toEqual({
      notModified: false,
      columns: ['id', 'Name'],
      rows: 1201,
      state: { etag: '"e"' },
    });
    expect(pages.map((p) => p.length)).toEqual([500, 500, 201]);
    expect(pages[0]?.[0]).toEqual(['1', 'Name\n1']);
    expect(pages[2]?.at(-1)).toEqual(['1201', 'Name\n1201']);
  });

  it('stops past maxRows, and a preview after its first rows without reading on', async () => {
    await expect(
      streamCsv(streamingHttp({ body: csv }).http, 'https://x/a.csv', {
        maxRows: 1200,
        onRows: () => {},
      })
    ).rejects.toThrow(TooManyRows);
    const { http, sent } = streamingHttp({ body: csv }, 64);
    const read = await readCsv(http, 'https://x/a.csv', { maxRows: 10, limit: 3 });
    expect(read.notModified === false && read.rows).toEqual([
      ['1', 'Name\n1'],
      ['2', 'Name\n2'],
      ['3', 'Name\n3'],
    ]);
    expect(sent.pieces).toBeLessThan(5);
  });

  it('checks the status and type before reading the body', async () => {
    const { http, sent } = streamingHttp({ status: 500, body: csv });
    await expect(readCsv(http, 'https://x/a', { maxRows: 10 })).rejects.toThrow(/answered 500/);
    const page = streamingHttp({ body: '<html>', headers: { 'content-type': 'text/html' } });
    await expect(readCsv(page.http, 'https://x/a', { maxRows: 10 })).rejects.toThrow(/web page/);
    expect(sent.pieces + page.sent.pieces).toBe(0);
  });

  it('fails a row past maxRowChars while it downloads, not once it is held', async () => {
    const body = `id,Name\n1,"${'x'.repeat(10_000)}"\n`;
    const { http, sent } = streamingHttp({ body }, 100);
    await expect(
      streamCsv(http, 'https://x/a.csv', { maxRows: 10, maxRowChars: 1000, onRows: () => {} })
    ).rejects.toThrow(
      new SourceError("The file isn't valid CSV: A row is longer than 1,000 characters (line 2)")
    );
    expect(sent.pieces).toBeLessThan(15);
  });
});

describe('CSV sources (#155)', () => {
  it('reads the header and rows, empty cells as null, names made unique', async () => {
    const read = await readCsv(fakeHttp({ body: 'Name,,Name\nAda,1,x\nBob\n' }), 'https://x/a', {
      maxRows: 10,
    });
    expect(read).toEqual({
      notModified: false,
      columns: ['Name', 'Column 2', 'Name 2'],
      rows: [
        ['Ada', '1', 'x'],
        ['Bob', null, null],
      ],
      state: {},
    });
  });

  it('sends the last ETag and Last-Modified and reads a 304 as not modified', async () => {
    const seen: Record<string, string>[] = [];
    const http = fakeHttp({ status: 304 }, seen);
    const state = { etag: '"v1"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' };
    expect(await readCsv(http, 'https://x/a.csv', { maxRows: 10, state })).toEqual({
      notModified: true,
    });
    expect(seen[0]).toMatchObject({
      'if-none-match': '"v1"',
      'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
    });
  });

  it('keeps the validators of a 200 for the next run', async () => {
    const read = await readCsv(
      fakeHttp({ body: 'a\n1\n', headers: { etag: '"v2"', 'content-type': 'text/csv' } }),
      'https://x/a.csv',
      { maxRows: 10 }
    );
    expect(read.notModified === false && read.state).toEqual({ etag: '"v2"' });
  });

  it('refuses error statuses, web pages, bad CSV and too many rows', async () => {
    const opts = { maxRows: 1 };
    await expect(readCsv(fakeHttp({ status: 404 }), 'https://x/a', opts)).rejects.toThrow(
      /answered 404/
    );
    await expect(
      readCsv(
        fakeHttp({ body: '<html>', headers: { 'content-type': 'text/html' } }),
        'https://x/a',
        opts
      )
    ).rejects.toThrow(/web page/);
    await expect(readCsv(fakeHttp({ body: 'a\n"open' }), 'https://x/a', opts)).rejects.toThrow(
      SourceError
    );
    await expect(readCsv(fakeHttp({ body: 'a\n1\n2\n' }), 'https://x/a', opts)).rejects.toThrow(
      TooManyRows
    );
  });

  it('labels a URL without its query and names the table after the file', () => {
    expect(csvLabel('https://data.example.com/exports/people.csv?token=secret')).toBe(
      'data.example.com/exports/people.csv'
    );
    expect(csvTableName('https://data.example.com/exports/My%20people.csv?x=1')).toBe('My people');
    expect(csvTableName('https://data.example.com/')).toBe('CSV');
  });

  it('makes column names unique ignoring case', () => {
    expect(columnNames(['id', 'ID', ' ', 'id'])).toEqual(['id', 'ID 2', 'Column 3', 'id 3']);
  });
});

describe('Postgres sources (#155)', () => {
  it('parses postgres:// URLs, decoding the user and password', () => {
    expect(parseConnectionString('postgres://re%40der:p%2Fss@db.example.com/crm', false)).toEqual({
      host: 'db.example.com',
      port: 5432,
      user: 're@der',
      password: 'p/ss',
      database: 'crm',
      sslmode: 'verify-full',
    });
    expect(
      parseConnectionString('postgresql://u@db.example.com:6543/crm?sslmode=require', true)
    ).toMatchObject({ port: 6543, sslmode: 'require', password: '' });
  });

  it("refuses what isn't a plain URL: other settings, no user or database, sockets", () => {
    const bad = [
      'mysql://u:p@db/x',
      'postgres://db.example.com/crm',
      'postgres://u:p@db.example.com',
      'postgres://u:p@db.example.com/crm?host=/var/run/postgresql',
      'postgres://u:p@db.example.com/crm?options=-c%20x',
      'postgres://u:p@db.example.com/crm?sslmode=prefer',
      'postgres://u:p@/crm',
    ];
    for (const s of bad) expect(() => parseConnectionString(s, false), s).toThrow(SourceError);
  });

  it('requires TLS when the instance does', () => {
    expect(() =>
      parseConnectionString('postgres://u:p@db.example.com/crm?sslmode=disable', true)
    ).toThrow(/only connects to databases over TLS/);
    expect(
      parseConnectionString('postgres://u:p@db.example.com/crm?sslmode=disable', false).sslmode
    ).toBe('disable');
  });

  it("never puts the password in the label or a problem's message", () => {
    const conn = parseConnectionString('postgres://u:hunter2@db.example.com/crm', false);
    expect(postgresLabel(conn, { table: 'public.people' })).toBe(
      'db.example.com/crm · public.people'
    );
    const err = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), {
      code: 'ECONNREFUSED',
    });
    expect(postgresProblem(err).message).toBe("Couldn't connect to the database.");
  });

  it('quotes table names and accepts one SELECT or WITH query', () => {
    expect(quotedTable('public.People')).toBe('"public"."People"');
    expect(() => quotedTable('a"; drop table x; --')).toThrow(SourceError);
    expect(checkedQuery('  -- people\n/* all */ select * from people;  ')).toBe(
      '-- people\n/* all */ select * from people'
    );
    expect(checkedQuery('WITH a AS (SELECT 1) SELECT * FROM a')).toMatch(/^WITH/);
    for (const q of ['delete from people', 'update x set y = 1', 'copy x to stdout', 'set x = 1']) {
      expect(() => checkedQuery(q), q).toThrow(/one SELECT statement/);
    }
  });

  it('refuses private, loopback and metadata hosts before connecting', async () => {
    const hostCheck = createHostCheck(outboundPolicy(), {
      resolve: async (host) =>
        host === 'internal.example.com' ? [{ address: '10.0.0.5', family: 4 }] : [],
    });
    const deps = { hostCheck, requireTls: true };
    for (const host of [
      '127.0.0.1',
      '[::1]',
      '169.254.169.254',
      'localhost',
      'internal.example.com',
    ]) {
      await expect(
        readPostgres(deps, `postgres://u:p@${host}/crm`, { table: 'people' }, { maxRows: 1 }),
        host
      ).rejects.toThrow(/private or reserved address/);
    }
  });
});
