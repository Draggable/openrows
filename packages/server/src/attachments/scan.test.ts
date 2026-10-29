import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EICAR, type FakeClamd, startFakeClamd } from '../../test/helpers/clamd.js';
import { clamdScanner, parseClamavUrl, parseClamdReply, ScannerUnavailableError } from './scan.js';

async function* body(...parts: (string | Uint8Array)[]) {
  for (const p of parts) yield typeof p === 'string' ? new TextEncoder().encode(p) : p;
}

describe('parseClamavUrl', () => {
  it('reads tcp://host:port, port 3310 by default', () => {
    expect(parseClamavUrl('tcp://clamav:3310')).toEqual({ host: 'clamav', port: 3310 });
    expect(parseClamavUrl('tcp://10.0.0.5')).toEqual({ host: '10.0.0.5', port: 3310 });
    expect(parseClamavUrl('tcp://[::1]:9999')).toEqual({ host: '::1', port: 9999 });
  });
  it('refuses anything else', () => {
    for (const bad of [
      'http://clamav:3310',
      'clamav:3310',
      'tcp://',
      'tcp://a:0',
      'tcp://a:70000',
      'tcp://a b',
    ]) {
      expect(parseClamavUrl(bad), bad).toBeNull();
    }
  });
});

describe('parseClamdReply', () => {
  it('reads OK and FOUND', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ infected: false });
    expect(parseClamdReply('stream: Eicar-Test-Signature FOUND\0')).toEqual({
      infected: true,
      signature: 'Eicar-Test-Signature',
    });
  });
  it('fails closed on errors and garbage', () => {
    for (const reply of ['INSTREAM size limit exceeded. ERROR\0', '', 'stream: \0', 'PONG']) {
      expect(() => parseClamdReply(reply), reply).toThrow(ScannerUnavailableError);
    }
  });
  it('keeps a signature short and printable', () => {
    const v = parseClamdReply(`stream: ${'A'.repeat(500)}\x07 FOUND`);
    expect(v).toEqual({ infected: true, signature: 'A'.repeat(200) });
  });
});

describe('clamdScanner', () => {
  let clamd: FakeClamd;
  beforeAll(async () => {
    clamd = await startFakeClamd({ streamMaxLength: 1024 * 1024 });
  });
  afterAll(() => clamd.close());
  const scanner = () => clamdScanner({ host: clamd.host, port: clamd.port, timeoutMs: 2000 });

  it('passes a clean file', async () => {
    expect(await scanner().scan(body('hello', ' world'))).toEqual({ infected: false });
  });

  it('finds the EICAR test file, also split across chunks and past 64 KB', async () => {
    expect(await scanner().scan(body(EICAR))).toEqual({
      infected: true,
      signature: 'Eicar-Test-Signature',
    });
    const big = new Uint8Array(200 * 1024).fill(32);
    expect(await scanner().scan(body(big, EICAR.slice(0, 10), EICAR.slice(10)))).toMatchObject({
      infected: true,
    });
  });

  it('pings', async () => {
    expect(await scanner().ping()).toBe(true);
    expect(await clamdScanner({ host: '127.0.0.1', port: 1 }).ping()).toBe(false);
  });

  it('fails closed when clamd errors, hangs, refuses the size or is down', async () => {
    clamd.mode = 'error';
    await expect(scanner().scan(body(EICAR))).rejects.toThrow(ScannerUnavailableError);
    clamd.mode = 'limit';
    await expect(scanner().scan(body(new Uint8Array(300 * 1024)))).rejects.toThrow(/size limit/);
    clamd.mode = 'hang';
    await expect(scanner().scan(body('x'))).rejects.toThrow(/timed out/);
    clamd.mode = 'ok';
    await expect(clamdScanner({ host: '127.0.0.1', port: 1 }).scan(body('x'))).rejects.toThrow(
      /unreachable/
    );
  });
});
