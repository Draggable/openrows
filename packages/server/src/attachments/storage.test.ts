import { isInlineImageType } from '@openrows/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentDisposition } from './service.js';
import {
  ObjectStoreError,
  parseListPage,
  S3ObjectStore,
  SIGN_WINDOW_MS,
  UnknownObjectSizeError,
} from './storage.js';

const s3 = {
  endpoint: 'http://s3:9000/',
  region: 'us-east-1',
  bucket: 'openrows',
  accessKey: 'key',
  secretKey: 'secret',
  publicUrl: 'https://usercontent.example/openrows',
};

describe('S3ObjectStore presigned URLs', () => {
  afterEach(() => vi.useRealTimers());

  it('signs uploads for the public URL, the exact length and the type', async () => {
    const store = new S3ObjectStore(s3);
    const { url, headers } = await store.presignPut('ws/1/b/2/t/3/4', {
      contentType: 'image/png',
      size: 42,
      expiresIn: 900,
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('https://usercontent.example/openrows/ws/1/b/2/t/3/4');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(headers).toEqual({ 'content-type': 'image/png' });
  });

  it('falls back to the endpoint and bucket without a public URL', async () => {
    const store = new S3ObjectStore({ ...s3, publicUrl: undefined });
    const url = await store.presignGet('k', {
      contentType: 'text/html',
      disposition: 'attachment; filename="x.html"',
      expiresIn: 600,
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe('http://s3:9000/openrows/k');
    expect(u.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="x.html"'
    );
    expect(u.searchParams.get('response-content-type')).toBe('text/html');
  });

  it('gives the same download URL within a signing window', async () => {
    vi.useFakeTimers();
    const store = new S3ObjectStore(s3);
    const opts = { contentType: 'image/png', disposition: 'inline', expiresIn: 600 };
    vi.setSystemTime(Math.ceil(Date.now() / SIGN_WINDOW_MS) * SIGN_WINDOW_MS + 1000);
    const first = await store.presignGet('k', opts);
    vi.advanceTimersByTime(SIGN_WINDOW_MS - 2000);
    expect(await store.presignGet('k', opts)).toBe(first);
    vi.advanceTimersByTime(2000);
    expect(await store.presignGet('k', opts)).not.toBe(first);
  });

  it('signs with region auto (Cloudflare R2)', async () => {
    const store = new S3ObjectStore({ ...s3, region: 'auto', publicUrl: undefined });
    const put = await store.presignPut('k', { contentType: 'text/html', size: 51, expiresIn: 900 });
    const get = await store.presignGet('k', {
      contentType: 'text/html',
      disposition: 'attachment; filename="x.html"',
      expiresIn: 600,
    });
    for (const url of [put.url, get]) {
      expect(new URL(url).searchParams.get('X-Amz-Credential')).toMatch(
        /^key\/\d{8}\/auto\/s3\/aws4_request$/
      );
    }
    expect(new URL(put.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host'
    );
  });
});

/** Every request the store sends, and a stand-in S3 answering them. */
function fakeS3(answer: (req: Request) => Response) {
  const requests: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (req: Request) => {
      requests.push(req);
      return answer(req);
    })
  );
  return requests;
}

const html = new TextEncoder().encode(`<!doctype html><title>x</title><p>${'a'.repeat(20)}</p>`);

/** Like R2: compressible types go out gzip'd, with no Content-Length, to clients that accept it. */
function r2Like(req: Request): Response {
  const gzip = /gzip|br/.test(req.headers.get('accept-encoding') ?? '');
  const headers: Record<string, string> = gzip
    ? { 'content-type': 'text/html', 'content-encoding': 'gzip' }
    : { 'content-type': 'text/html', 'content-length': String(html.byteLength) };
  return new Response(req.method === 'HEAD' || gzip ? null : html, { status: 200, headers });
}

describe('S3ObjectStore server-side requests', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = new S3ObjectStore({ ...s3, region: 'auto' });

  it('asks for the stored bytes as they are, outside the signature', async () => {
    const requests = fakeS3(r2Like);
    expect(await store.head('k')).toEqual({ size: html.byteLength });
    expect(await store.get('k', 1000)).toEqual(html);
    for (const req of requests) {
      expect(req.headers.get('accept-encoding')).toBe('identity');
      const signed = /SignedHeaders=([^,]+)/.exec(req.headers.get('authorization') ?? '')?.[1];
      expect(signed?.split(';')).not.toContain('accept-encoding');
      expect(req.headers.get('authorization')).toContain('/auto/s3/aws4_request');
    }
  });

  it('reads the size from Content-Range when HEAD leaves the length out', async () => {
    const requests = fakeS3((req) =>
      req.method === 'HEAD'
        ? new Response(null, { headers: { 'content-encoding': 'gzip', 'content-length': '20' } })
        : new Response('<', { status: 206, headers: { 'content-range': 'bytes 0-0/51' } })
    );
    expect(await store.head('k')).toEqual({ size: 51 });
    expect(requests[1]?.method).toBe('GET');
    expect(requests[1]?.headers.get('range')).toBe('bytes=0-0');
  });

  it('reads an empty object from a 416', async () => {
    fakeS3((req) =>
      req.method === 'HEAD'
        ? new Response(null, { headers: { 'transfer-encoding': 'chunked' } })
        : new Response(null, { status: 416, headers: { 'content-range': 'bytes */0' } })
    );
    expect(await store.head('k')).toEqual({ size: 0 });
  });

  it('never guesses a size the store does not report', async () => {
    for (const length of [null, '', 'abc', '-1', '1e3']) {
      fakeS3(
        () => new Response(null, { headers: length === null ? {} : { 'content-length': length } })
      );
      await expect(store.head('k'), String(length)).rejects.toBeInstanceOf(UnknownObjectSizeError);
    }
  });

  it('answers null for a missing object', async () => {
    fakeS3(() => new Response(null, { status: 404 }));
    expect(await store.head('k')).toBeNull();
  });

  it('caps a download by the bytes that arrive, whatever the headers say', async () => {
    fakeS3(() => new Response(html));
    await expect(store.get('k', html.byteLength - 1)).rejects.toThrow(ObjectStoreError);
    fakeS3(() => new Response(html, { headers: { 'content-length': '999999' } }));
    await expect(store.get('k', 1000)).rejects.toThrow(/larger than 1000 bytes/);
    fakeS3(() => new Response(html));
    expect(await store.get('k', html.byteLength)).toEqual(html);
  });
});

describe('S3ObjectStore copy (#142)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = new S3ObjectStore(s3);

  it('copies server-side with the signed copy source', async () => {
    const requests = fakeS3(() => new Response('<CopyObjectResult></CopyObjectResult>'));
    await store.copy('ws/a/b/c/t/d/e f', 'ws/x/b/y/t/z/n');
    const [req] = requests;
    expect(req?.method).toBe('PUT');
    expect(req?.url).toBe('http://s3:9000/openrows/ws/x/b/y/t/z/n');
    expect(req?.headers.get('x-amz-copy-source')).toBe('/openrows/ws/a/b/c/t/d/e%20f');
    const signed = /SignedHeaders=([^,]+)/.exec(req?.headers.get('authorization') ?? '')?.[1];
    expect(signed?.split(';')).toContain('x-amz-copy-source');
  });

  it('fails on an error status or a late <Error> body', async () => {
    fakeS3(() => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }));
    await expect(store.copy('a', 'b')).rejects.toThrow(ObjectStoreError);
    fakeS3(() => new Response('<Error><Code>InternalError</Code></Error>'));
    await expect(store.copy('a', 'b')).rejects.toThrow(ObjectStoreError);
  });
});

describe('download dispositions', () => {
  it('shows only raster images inline; HTML, SVG and other active types download', () => {
    for (const type of [
      'text/html',
      'TEXT/HTML',
      'application/xhtml+xml',
      'image/svg+xml',
      'text/xml',
      'application/xml',
      'text/javascript',
      'application/pdf',
      'application/octet-stream',
    ]) {
      expect(isInlineImageType(type), type).toBe(false);
    }
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG']) {
      expect(isInlineImageType(type), type).toBe(true);
    }
  });
});

describe('contentDisposition', () => {
  it('quotes an ASCII fallback and adds the UTF-8 name', () => {
    expect(contentDisposition('attachment', 'résumé "final".pdf')).toBe(
      `attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`
    );
  });
});

describe('parseListPage (#76)', () => {
  it('reads the keys and the continuation token of a ListObjectsV2 answer', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>b</Name><Prefix>ws/1/</Prefix><KeyCount>2</KeyCount>
<IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken>
<Contents><Key>ws/1/a.txt</Key><Size>3</Size></Contents>
<Contents><Key>ws/1/b &amp; c.txt</Key><Size>4</Size></Contents></ListBucketResult>`;
    expect(parseListPage(xml)).toEqual({ keys: ['ws/1/a.txt', 'ws/1/b & c.txt'], next: 'a&b' });
    expect(
      parseListPage('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')
    ).toEqual({ keys: [], next: undefined });
  });
});
