import type { AirtableBase } from '@openrows/shared';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { type SafeFetch, SafeFetchError, type SafeResponse } from '../lib/safe-fetch/index.js';

/**
 * Airtable's Web API, read-only, for the importer. Every request goes through the
 * SSRF-safe client to `https://api.airtable.com` and nowhere else: the URLs are built
 * here from checked ids, and redirects aren't followed. Requests are spaced to Airtable's 5 per
 * second per base, and a 429 waits Airtable's 30 seconds before trying again.
 *
 * The token goes in the Authorization header only. Errors never carry it, nor Airtable's
 * answer: they say what the person can do about it.
 *
 * Attachments are downloaded from Airtable's file hosts only (`AIRTABLE_ATTACHMENT_HOSTS`:
 * dl.airtable.com and *.airtableusercontent.com), again through the SSRF-safe client, without
 * the token (Airtable's file URLs are signed), up to MAX_AIRTABLE_ATTACHMENT_BYTES.
 *
 * Dev and CI stacks point `origin` at a fake Airtable (`AIRTABLE_API_URL`); production needs
 * https.
 */

export const AIRTABLE_ORIGIN = 'https://api.airtable.com';
export const AIRTABLE_HOST = 'api.airtable.com';
export const AIRTABLE_ATTACHMENT_HOSTS = ['dl.airtable.com', '*.airtableusercontent.com'];
/** Airtable allows 5 requests per second per base. */
export const AIRTABLE_MIN_INTERVAL_MS = 200;
/** What Airtable asks for after a 429. */
export const AIRTABLE_RETRY_AFTER_MS = 30_000;
const MAX_RATE_LIMIT_RETRIES = 3;
/** Most pages of bases a token lists (100 bases a page). */
const MAX_BASE_PAGES = 20;
/** Records pages hold up to 100 records with long text: allow some room. */
const MAX_PAGE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const id = (prefix: string) => new RegExp(`^${prefix}[A-Za-z0-9]{14}$`);
const offsetSchema = z.string().max(1000).optional();

export const airtableFieldSchema = z.object({
  id: z.string().regex(id('fld')),
  name: z.string(),
  type: z.string(),
  description: z.string().optional(),
  options: z.record(z.string(), z.unknown()).nullish(),
});
export type AirtableField = z.infer<typeof airtableFieldSchema>;

export const airtableViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  /** Grid views' visible fields, in their order (`include=visibleFieldIds`). */
  visibleFieldIds: z.array(z.string()).max(1000).optional(),
});
export type AirtableView = z.infer<typeof airtableViewSchema>;

export const airtableTableSchema = z.object({
  id: z.string().regex(id('tbl')),
  name: z.string(),
  description: z.string().optional(),
  primaryFieldId: z.string(),
  fields: z.array(airtableFieldSchema),
  views: z.array(airtableViewSchema).max(1000).default([]),
});
export type AirtableTable = z.infer<typeof airtableTableSchema>;

const basesPageSchema = z.object({
  bases: z.array(
    z.object({ id: z.string().regex(id('app')), name: z.string(), permissionLevel: z.string() })
  ),
  offset: offsetSchema,
});
const schemaSchema = z.object({ tables: z.array(airtableTableSchema) });
export const airtableRecordSchema = z.object({
  id: z.string().regex(id('rec')),
  createdTime: z.string().optional(),
  fields: z.record(z.string(), z.unknown()),
});
export type AirtableRecord = z.infer<typeof airtableRecordSchema>;
const recordsPageSchema = z.object({
  records: z.array(airtableRecordSchema),
  offset: offsetSchema,
});
export type AirtableRecordsPage = z.infer<typeof recordsPageSchema>;

export interface AirtableClientDeps {
  http: SafeFetch;
  /** The Web API's origin (default https://api.airtable.com). */
  origin?: string;
  /** The hosts files are downloaded from (default AIRTABLE_ATTACHMENT_HOSTS). */
  attachmentHosts?: readonly string[];
  /** Waits (tests skip the 30 s). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface AirtableClient {
  listBases(): Promise<AirtableBase[]>;
  tables(baseId: string): Promise<AirtableTable[]>;
  records(baseId: string, tableId: string, offset?: string): Promise<AirtableRecordsPage>;
  /** A file from Airtable's file hosts: its bytes and declared type. */
  download(url: string, maxBytes: number): Promise<{ body: Uint8Array; contentType: string }>;
}

/** Whether `host` is one of `hosts` (`*.example.com`: its subdomains). */
export function attachmentHostAllowed(host: string, hosts: readonly string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((rule) =>
    rule.startsWith('*.') ? h.endsWith(rule.slice(1)) && h.length > rule.length - 1 : h === rule
  );
}

/** Why a file wasn't copied: a message for the report. */
export class AttachmentError extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the importer tells the person when Airtable refuses or fails (no Airtable text). */
function failure(status: number, what: string): AppError {
  if (status === 401) {
    return new AppError('VALIDATION_FAILED', {
      detail: 'Airtable rejected the token. Check it, or create a new one.',
      extensions: { errors: [{ path: 'token', message: 'Airtable rejected this token.' }] },
    });
  }
  if (status === 403 || status === 404) {
    return new AppError('VALIDATION_FAILED', {
      detail: `The token can't read ${what}. Give it the scopes data.records:read and schema.bases:read, and access to the base.`,
      extensions: {
        errors: [{ path: 'token', message: `The token can't read ${what}.` }],
      },
    });
  }
  if (status === 422) {
    // Mostly an expired records offset (LIST_RECORDS_ITERATOR_NOT_AVAILABLE).
    return new AppError('CONFLICT', { detail: `Airtable refused to list ${what}. Try again.` });
  }
  return new AppError('SERVICE_UNAVAILABLE', {
    detail: `Airtable didn't answer (${status}). Try again later.`,
  });
}

export function createAirtableClient(token: string, deps: AirtableClientDeps): AirtableClient {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const origin = new URL(deps.origin ?? AIRTABLE_ORIGIN).origin;
  const fileHosts = deps.attachmentHosts ?? AIRTABLE_ATTACHMENT_HOSTS;
  let next = 0;

  async function get(path: string, what: string): Promise<unknown> {
    const url = new URL(path, origin);
    // Built from checked ids, but checked again: Airtable is the only host this client calls.
    if (url.origin !== origin) throw new Error("airtable: refused a URL off Airtable's API");
    for (let attempt = 0; ; attempt++) {
      const wait = next - now();
      if (wait > 0) await sleep(wait);
      next = Math.max(now(), next) + AIRTABLE_MIN_INTERVAL_MS;
      let res: SafeResponse;
      try {
        res = await deps.http(url, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          maxRedirects: 0,
          maxBytes: MAX_PAGE_BYTES,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof SafeFetchError) {
          throw new AppError('SERVICE_UNAVAILABLE', {
            detail: `Airtable couldn't be reached: ${err.message}`,
          });
        }
        throw err;
      }
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleep(AIRTABLE_RETRY_AFTER_MS);
        next = now() + AIRTABLE_MIN_INTERVAL_MS;
        continue;
      }
      if (res.status !== 200) throw failure(res.status, what);
      try {
        return JSON.parse(res.text());
      } catch {
        throw new AppError('SERVICE_UNAVAILABLE', {
          detail: 'Airtable sent an unreadable answer.',
        });
      }
    }
  }

  function parse<T>(schema: z.ZodType<T>, data: unknown): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new AppError('SERVICE_UNAVAILABLE', { detail: 'Airtable sent an unexpected answer.' });
    }
    return parsed.data;
  }

  return {
    async listBases() {
      const bases: AirtableBase[] = [];
      let offset: string | undefined;
      for (let page = 0; page < MAX_BASE_PAGES; page++) {
        const q = offset ? `?offset=${encodeURIComponent(offset)}` : '';
        const data = parse(basesPageSchema, await get(`/v0/meta/bases${q}`, 'your bases'));
        bases.push(...data.bases);
        offset = data.offset;
        if (!offset) break;
      }
      return bases;
    },
    async tables(baseId) {
      if (!id('app').test(baseId)) throw new Error('airtable: bad base id');
      const data = await get(
        `/v0/meta/bases/${baseId}/tables?include=visibleFieldIds`,
        "the base's schema"
      );
      return parse(schemaSchema, data).tables;
    },
    async records(baseId, tableId, offset) {
      if (!id('app').test(baseId) || !id('tbl').test(tableId)) {
        throw new Error('airtable: bad base or table id');
      }
      const q = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' });
      if (offset) q.set('offset', offset);
      const data = await get(`/v0/${baseId}/${tableId}?${q}`, "the base's records");
      return parse(recordsPageSchema, data);
    },
    async download(raw, maxBytes) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new AttachmentError('Airtable gave no usable file URL.');
      }
      if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        !attachmentHostAllowed(url.hostname, fileHosts)
      ) {
        throw new AttachmentError(`Files are only copied from Airtable's hosts, not ${url.host}.`);
      }
      let res: SafeResponse;
      try {
        // No token: Airtable's file URLs are signed. No redirects: a file URL must be on an allowed host itself.
        res = await deps.http(url, {
          maxRedirects: 0,
          maxBytes,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof SafeFetchError) {
          throw new AttachmentError(
            err.code === 'RESPONSE_TOO_LARGE'
              ? `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`
              : `The file couldn't be downloaded: ${err.message}`
          );
        }
        throw err;
      }
      if (res.status !== 200) {
        throw new AttachmentError(`Airtable answered ${res.status} for the file.`);
      }
      return {
        body: new Uint8Array(res.body),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },
  };
}
