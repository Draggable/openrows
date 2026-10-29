import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unzip } from '../../test/helpers/unzip.js';
import { type ZipEntry, zip, zipStream } from './zip.js';

async function bytes(entries: ZipEntry[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of zip(entries)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function hasUnzip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('zip', () => {
  const entries = (): ZipEntry[] => [
    { name: 'schema.json', data: ['{"a":', '1}'] },
    {
      name: 'tables/Tâches été.csv',
      data: (function* () {
        yield 'x,y\n';
        yield '1,2\n';
      })(),
    },
    { name: 'attachments/a/photo.bin', data: [new Uint8Array([0, 1, 2, 255])], store: true },
    { name: 'empty.txt', data: [] },
  ];

  it('writes entries a reader gets back byte for byte', async () => {
    const files = unzip(await bytes(entries()));
    expect([...files.keys()]).toEqual([
      'schema.json',
      'tables/Tâches été.csv',
      'attachments/a/photo.bin',
      'empty.txt',
    ]);
    expect(files.get('schema.json')?.toString()).toBe('{"a":1}');
    expect(files.get('tables/Tâches été.csv')?.toString()).toBe('x,y\n1,2\n');
    expect([...(files.get('attachments/a/photo.bin') ?? [])]).toEqual([0, 1, 2, 255]);
    expect(files.get('empty.txt')?.length).toBe(0);
  });

  it('compresses text and passes stored entries through', async () => {
    const text = 'name,value\n'.repeat(10_000);
    const archive = await bytes([{ name: 'big.csv', data: [text] }]);
    expect(archive.byteLength).toBeLessThan(text.length / 20);
    expect(unzip(archive).get('big.csv')?.toString()).toBe(text);
  });

  it('refuses duplicate names', async () => {
    await expect(
      bytes([
        { name: 'a', data: [] },
        { name: 'a', data: [] },
      ])
    ).rejects.toThrow(/duplicate/);
  });

  it.runIf(hasUnzip())('passes `unzip -t`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openrows-zip-'));
    try {
      const file = join(dir, 'export.zip');
      writeFileSync(file, await bytes(entries()));
      const out = execFileSync('unzip', ['-t', file]).toString();
      expect(out).toMatch(/No errors detected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('streams as a web stream and reports a failing entry', async () => {
    const errors: unknown[] = [];
    const stream = zipStream(
      [
        {
          name: 'bad',
          data: (async function* () {
            yield 'ok';
            throw new Error('boom');
          })(),
        },
      ],
      (err) => errors.push(err)
    );
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow();
    expect(errors).toHaveLength(1);
  });
});
