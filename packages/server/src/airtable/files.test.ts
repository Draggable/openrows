import { describe, expect, it } from 'vitest';
import { PNG_1PX } from './__fixtures__/fake.js';
import { attachmentHostAllowed } from './client.js';
import { airtableFiles, cleanFilename, copyFile, mapLimit, sniffType } from './files.js';

describe('Airtable attachments', () => {
  it('allows only the file hosts, subdomains by *.', () => {
    const hosts = ['dl.airtable.com', '*.airtableusercontent.com'];
    expect(attachmentHostAllowed('dl.airtable.com', hosts)).toBe(true);
    expect(attachmentHostAllowed('V5.AirtableUserContent.com', hosts)).toBe(true);
    expect(attachmentHostAllowed('airtableusercontent.com', hosts)).toBe(false);
    expect(attachmentHostAllowed('evilairtableusercontent.com', hosts)).toBe(false);
    expect(attachmentHostAllowed('dl.airtable.com.evil.test', hosts)).toBe(false);
    expect(attachmentHostAllowed('api.airtable.com', hosts)).toBe(false);
  });

  it('types files by their bytes, never trusting an image type', () => {
    expect(sniffType(PNG_1PX, 'application/octet-stream')).toBe('image/png');
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), undefined)).toBe('image/jpeg');
    expect(sniffType(Buffer.from('<svg/>'), 'image/png')).toBe('application/octet-stream');
    expect(sniffType(Buffer.from('<svg/>'), 'image/svg+xml')).toBe('image/svg+xml');
    expect(sniffType(Buffer.from('a'), 'Text/Plain; charset=utf-8')).toBe('text/plain');
    expect(sniffType(Buffer.from('a'), 'not a type')).toBe('application/octet-stream');
  });

  it("reads Airtable's cells and cleans file names", () => {
    expect(
      airtableFiles([
        { id: 'att1', url: 'https://dl.airtable.com/a', filename: '../a\u0000.png', size: 3 },
        { id: 'att2' },
        'junk',
      ])
    ).toEqual([{ url: 'https://dl.airtable.com/a', filename: '..a.png', size: 3 }]);
    expect(airtableFiles(null)).toEqual([]);
    expect(cleanFilename('  ')).toBe('file');
    expect(cleanFilename('x'.repeat(300))).toHaveLength(255);
  });

  it('runs downloads a few at a time, in order', async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(most).toBe(2);
  });

  it('reports a file it cannot copy', async () => {
    const target = { workspaceId: 'w', baseId: 'b', tableId: 't' };
    const download = async () => ({ body: PNG_1PX, contentType: 'image/png' });
    expect(await copyFile({ download }, undefined, target, { url: 'x', filename: 'a' })).toEqual({
      error: "File storage isn't configured here.",
    });
    const huge = { url: 'x', filename: 'a', size: 101 * 1024 * 1024 };
    const store = { put: async () => {} } as never;
    expect(await copyFile({ download }, store, target, huge)).toEqual({
      error: 'The file is larger than 100 MB.',
    });
  });
});
