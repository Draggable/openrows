import { AwsClient } from 'aws4fetch';
import type { S3Config } from '../config.js';

/**
 * The S3-compatible object store behind attachments: Versity in dev, Cloudflare R2 in the
 * hosted service, any S3 elsewhere. Path-style URLs, SigV4 through aws4fetch (region `auto`
 * for R2). Browser-facing URLs (the presigned PUT and GET) are signed for `S3_PUBLIC_URL` (the
 * bucket's public base URL) when it is set, e.g. a usercontent domain whose proxy passes the path
 * and the Host header through unchanged (they are signed); without it they use `S3_ENDPOINT`,
 * which must then be reachable from browsers (R2's is). The server's own requests go to
 * `S3_ENDPOINT`.
 */
export interface ObjectStore {
  /** A presigned PUT that only accepts exactly `size` bytes of `contentType`. */
  presignPut(
    key: string,
    opts: { contentType: string; size: number; expiresIn: number }
  ): Promise<{ url: string; headers: Record<string, string> }>;
  /** A presigned GET whose response carries this type and Content-Disposition. */
  presignGet(
    key: string,
    opts: { contentType: string; disposition: string; expiresIn: number }
  ): Promise<string>;
  /**
   * The stored object's size, or null when there is none. Throws UnknownObjectSizeError when the
   * store doesn't report one: a size is never guessed.
   */
  head(key: string): Promise<{ size: number } | null>;
  /** The object's bytes; throws once more than `maxBytes` arrive, whatever the headers say. */
  get(key: string, maxBytes: number): Promise<Uint8Array>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /**
   * Stores what `body` yields without holding all of it (a multipart upload of PART_SIZE parts
   * once it outgrows one part); returns the size. Base snapshots use it.
   */
  putStream(key: string, body: AsyncIterable<Uint8Array>, contentType: string): Promise<number>;
  /** The object's bytes as they arrive; throws when there is none. */
  getStream(key: string): Promise<AsyncIterable<Uint8Array>>;
  /**
   * Copies an object inside the bucket, server-side (CopyObject: no bytes through the server).
   * A duplicate base across workspaces gives each file a key of its new workspace.
   */
  copy(from: string, to: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every key under `prefix`, a page at a time (the purge of a workspace's files). */
  list(prefix: string): AsyncIterable<string>;
}

/** The part size of streamed uploads: S3's minimum is 5 MiB for every part but the last. */
export const PART_SIZE = 8 * 1024 * 1024;

/** Joins chunks into one buffer. */
export function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Regroups a byte stream into parts of `size` bytes (the last one shorter). */
export async function* parts(body: AsyncIterable<Uint8Array>, size: number) {
  let chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.byteLength;
    while (total >= size) {
      const joined = concatBytes(chunks, total);
      yield joined.slice(0, size);
      chunks = total > size ? [joined.slice(size)] : [];
      total -= size;
    }
  }
  if (total > 0 || chunks.length) yield concatBytes(chunks, total);
}

export class ObjectStoreError extends Error {
  override name = 'ObjectStoreError';
}

/** The store has the object but didn't tell its size; the object may well be fine. */
export class UnknownObjectSizeError extends ObjectStoreError {
  override name = 'UnknownObjectSizeError';
}

/** Presigned GETs are signed per window of this length (see presignGet). */
export const SIGN_WINDOW_MS = 5 * 60 * 1000;

const trim = (url: string) => url.replace(/\/+$/, '');

/**
 * Signs like AwsClient, then asks for the stored bytes as they are (`Accept-Encoding: identity`).
 * Node's fetch otherwise sends `gzip, deflate, br`, and R2 then compresses compressible types
 * (text/*, JSON, SVG...) on the fly: the response has no Content-Length (HEAD included), which
 * once made every confirm of an HTML file fail as "-1 bytes". The header is added after
 * signing, as a browser would, so a proxy that rewrites it can't break the signature.
 */
class IdentityClient extends AwsClient {
  override async sign(...args: Parameters<AwsClient['sign']>): Promise<Request> {
    const req = await super.sign(...args);
    req.headers.set('accept-encoding', 'identity');
    return req;
  }
}

/** A plain decimal Content-Length of the stored bytes, or null (missing, odd, or transcoded). */
function storedLength(res: Response): number | null {
  const encoding = res.headers.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') return null;
  const length = res.headers.get('content-length')?.trim();
  return length && /^\d+$/.test(length) ? Number(length) : null;
}

export class S3ObjectStore implements ObjectStore {
  readonly #client: IdentityClient;
  readonly #internal: string;
  readonly #public: string;
  readonly #bucket: string;

  constructor(s3: S3Config) {
    this.#client = new IdentityClient({
      accessKeyId: s3.accessKey,
      secretAccessKey: s3.secretKey,
      region: s3.region,
      service: 's3',
    });
    const bucket = encodeURIComponent(s3.bucket);
    this.#bucket = bucket;
    this.#internal = `${trim(s3.endpoint)}/${bucket}`;
    // S3_PUBLIC_URL already names the bucket (http://localhost:9000/openrows in dev).
    this.#public = s3.publicUrl ? trim(s3.publicUrl) : this.#internal;
  }

  #url(base: string, key: string): URL {
    return new URL(`${base}/${key.split('/').map(encodeURIComponent).join('/')}`);
  }

  async presignPut(key: string, opts: { contentType: string; size: number; expiresIn: number }) {
    const url = this.#url(this.#public, key);
    url.searchParams.set('X-Amz-Expires', String(opts.expiresIn));
    const headers = { 'content-type': opts.contentType, 'content-length': String(opts.size) };
    // allHeaders: sign Content-Type and Content-Length too, so another size or type is refused.
    const signed = await this.#client.sign(url.toString(), {
      method: 'PUT',
      headers,
      aws: { signQuery: true, allHeaders: true },
    });
    return { url: signed.url, headers: { 'content-type': opts.contentType } };
  }

  async presignGet(
    key: string,
    opts: { contentType: string; disposition: string; expiresIn: number }
  ) {
    const url = this.#url(this.#public, key);
    url.searchParams.set('X-Amz-Expires', String(opts.expiresIn));
    url.searchParams.set('response-content-type', opts.contentType);
    url.searchParams.set('response-content-disposition', opts.disposition);
    url.searchParams.set('response-cache-control', 'private, max-age=300');
    // Signed as of the start of the current window, so the URL (and the browser's cache of the
    // file) stays the same for a while; it is valid for at least `expiresIn - SIGN_WINDOW`.
    const start = Math.floor(Date.now() / SIGN_WINDOW_MS) * SIGN_WINDOW_MS;
    const datetime = new Date(start).toISOString().replace(/[:-]|\.\d{3}/g, '');
    const signed = await this.#client.sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true, datetime },
    });
    return signed.url;
  }

  async head(key: string) {
    const url = this.#url(this.#internal, key).toString();
    const res = await this.#client.fetch(url, { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new ObjectStoreError(`HEAD ${key} answered ${res.status}`);
    const size = storedLength(res);
    if (size !== null) return { size };
    // Some store or proxy still left the length out: a one-byte ranged GET names the total in
    // Content-Range (`bytes 0-0/<size>`, or `bytes */0` with a 416 for an empty object).
    const ranged = await this.#client.fetch(url, { headers: { range: 'bytes=0-0' } });
    await ranged.body?.cancel();
    if (ranged.status === 404) return null;
    const total = /^bytes (?:\d+-\d+|\*)\/(\d+)$/.exec(
      ranged.headers.get('content-range')?.trim() ?? ''
    )?.[1];
    if ((ranged.status === 206 || ranged.status === 416) && total !== undefined) {
      return { size: Number(total) };
    }
    const whole = ranged.status === 200 ? storedLength(ranged) : null;
    if (whole !== null) return { size: whole };
    throw new UnknownObjectSizeError(`${key}: the store reported no size (${ranged.status})`);
  }

  async get(key: string, maxBytes: number) {
    const res = await this.#client.fetch(this.#url(this.#internal, key).toString());
    const tooLarge = new ObjectStoreError(`${key} is larger than ${maxBytes} bytes`);
    if (!res.ok || (storedLength(res) ?? 0) > maxBytes) {
      await res.body?.cancel();
      throw res.ok ? tooLarge : new ObjectStoreError(`GET ${key} answered ${res.status}`);
    }
    // Count what arrives instead of trusting the headers (a missing length, a decoded body);
    // leaving the loop early cancels the stream.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body ?? []) {
      total += chunk.byteLength;
      if (total > maxBytes) throw tooLarge;
      chunks.push(chunk);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }

  async put(key: string, body: Uint8Array, contentType: string) {
    const res = await this.#client.fetch(this.#url(this.#internal, key).toString(), {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
    });
    if (!res.ok) throw new ObjectStoreError(`PUT ${key} answered ${res.status}`);
  }

  async putStream(key: string, body: AsyncIterable<Uint8Array>, contentType: string) {
    const url = this.#url(this.#internal, key);
    const iterator = parts(body, PART_SIZE)[Symbol.asyncIterator]();
    const first = await iterator.next();
    const firstPart = first.done ? new Uint8Array(0) : first.value;
    const second = first.done ? first : await iterator.next();
    if (second.done) {
      // One part or less: a plain PUT.
      await this.put(key, firstPart, contentType);
      return firstPart.byteLength;
    }
    const started = new URL(url);
    started.searchParams.set('uploads', '');
    const res = await this.#client.fetch(started.toString(), {
      method: 'POST',
      headers: { 'content-type': contentType },
    });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await res.text())?.[1];
    if (!res.ok || !uploadId) {
      throw new ObjectStoreError(`multipart upload of ${key} answered ${res.status}`);
    }
    const etags: string[] = [];
    let size = 0;
    try {
      const upload = async (part: Uint8Array) => {
        const partUrl = new URL(url);
        partUrl.searchParams.set('partNumber', String(etags.length + 1));
        partUrl.searchParams.set('uploadId', uploadId);
        const put = await this.#client.fetch(partUrl.toString(), { method: 'PUT', body: part });
        const etag = put.headers.get('etag');
        await put.body?.cancel();
        if (!put.ok || !etag) {
          throw new ObjectStoreError(`part ${etags.length + 1} of ${key} answered ${put.status}`);
        }
        etags.push(etag);
        size += part.byteLength;
      };
      await upload(firstPart);
      await upload(second.value);
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        await upload(next.value);
      }
      const done = new URL(url);
      done.searchParams.set('uploadId', uploadId);
      const xml = `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${etags
        .map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`;
      const completed = await this.#client.fetch(done.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: xml,
      });
      // S3 may answer 200 with an <Error> body when completing fails late.
      const text = await completed.text();
      if (!completed.ok || text.includes('<Error>')) {
        throw new ObjectStoreError(
          `completing ${key} answered ${completed.status}: ${text.slice(0, 300)}`
        );
      }
      return size;
    } catch (err) {
      const abort = new URL(url);
      abort.searchParams.set('uploadId', uploadId);
      await this.#client
        .fetch(abort.toString(), { method: 'DELETE' })
        .then((r) => r.body?.cancel())
        .catch(() => undefined);
      throw err;
    }
  }

  async getStream(key: string): Promise<AsyncIterable<Uint8Array>> {
    const res = await this.#client.fetch(this.#url(this.#internal, key).toString());
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new ObjectStoreError(`GET ${key} answered ${res.status}`);
    }
    return res.body;
  }

  async copy(from: string, to: string) {
    // The source is `/<bucket>/<key>`, URL-encoded like the request path.
    const source = `/${this.#bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
    const res = await this.#client.fetch(this.#url(this.#internal, to).toString(), {
      method: 'PUT',
      headers: { 'x-amz-copy-source': source },
    });
    // S3 may answer 200 with an <Error> body when the copy fails late.
    const text = await res.text();
    if (!res.ok || text.includes('<Error>')) {
      throw new ObjectStoreError(`COPY ${from} to ${to} answered ${res.status}`);
    }
  }

  async delete(key: string) {
    const res = await this.#client.fetch(this.#url(this.#internal, key).toString(), {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new ObjectStoreError(`DELETE ${key} answered ${res.status}`);
    }
  }

  /** ListObjectsV2, 1,000 keys per request. */
  async *list(prefix: string): AsyncIterable<string> {
    let token: string | undefined;
    do {
      const url = new URL(`${this.#internal}/`);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (token) url.searchParams.set('continuation-token', token);
      const res = await this.#client.fetch(url.toString(), { method: 'GET' });
      if (!res.ok) {
        await res.body?.cancel();
        throw new ObjectStoreError(`LIST ${prefix} answered ${res.status}`);
      }
      const page = parseListPage(await res.text());
      yield* page.keys;
      token = page.next;
    } while (token);
  }
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function xmlText(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, e: string) => {
    if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()] ?? '';
    const code =
      e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
    return String.fromCodePoint(code);
  });
}

/** The keys of a ListObjectsV2 answer and its continuation token (when truncated). */
export function parseListPage(xml: string): { keys: string[]; next: string | undefined } {
  const keys = [
    ...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g),
  ].map((m) => xmlText(m[1] ?? ''));
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { keys, next: truncated && next ? xmlText(next) : undefined };
}
