import { contracts, downloads, FORM_SUBJECT, MAX_FORM_SUBMISSION_BYTES } from '@openrows/shared';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { toValue, type UploadScanning } from '../attachments/service.js';
import type { ObjectStore } from '../attachments/storage.js';
import type { ThumbnailJobs } from '../attachments/thumbnails.js';
import { clientIp } from '../auth/client-ip.js';
import { rateLimit } from '../auth/rate-limit.js';
import type { RouteRegistry } from '../authz/routes.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { Jobs } from '../jobs/send.js';
import { AppError } from '../lib/errors.js';
import { hashShareToken, withFormShare } from '../shares/service.js';
import { requestUsageCheck } from '../usage/warnings.js';
import {
  confirmFormUpload,
  createFormUpload,
  formAccepting,
  formImageUrl,
  formLinkPage,
  loadForm,
  publicForm,
  submitForm,
} from './service.js';
import { type CaptchaVerifier, turnstileVerifier } from './turnstile.js';

/** The token segment of `/api/forms/<token>/...`. */
const tokenOf = (c: Context) => c.req.path.split('/')[3] ?? '';

const SUBMIT_WINDOW_MS = 10 * 60_000;
/** Each form takes this many times the per-IP limit across IPs. */
export const FORM_LIMIT_PER_FORM_FACTOR = 50;

/**
 * Public forms: no session, the form link's token is the credential (`withFormShare`
 * re-resolves it on every request, so revocation applies at once). Rate-limited per IP, and
 * submissions and uploads per form and IP and per form; bodies are capped. With Turnstile keys
 * configured, a submission needs a CAPTCHA token Cloudflare accepts; without them forms work
 * only outside production (production answers 503 and logs the missing keys at startup).
 */
export function formRoutes(
  routes: RouteRegistry,
  deps: {
    db: Database;
    config: Config;
    store: ObjectStore | undefined;
    thumbnails: ThumbnailJobs;
    captcha?: CaptchaVerifier | undefined;
    /** For `usage.check`: owners hear at once when their form refuses a response. */
    jobs?: Jobs | undefined;
    /** Malware scanning of submitters' uploads (CLAMAV_URL). */
    scanning?: UploadScanning | undefined;
  }
) {
  const { db, config } = deps;
  const ip = (c: Context) =>
    clientIp(c, { trustProxy: config.trustProxy, hops: config.trustProxyHops }) ?? 'unknown';
  const verify =
    deps.captcha ?? (config.turnstile ? turnstileVerifier(config.turnstile.secretKey) : undefined);
  const siteKey = config.turnstile?.siteKey ?? null;
  const ready = () => {
    if (config.isProduction && !verify) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: "This form isn't available: the server has no CAPTCHA configured.",
      });
    }
  };

  routes.use(
    '/api/forms/*',
    rateLimit({ limit: config.shareRateLimit, windowMs: 60_000, key: (c) => `ip:${ip(c)}` })
  );
  routes.use(
    '/api/forms/*',
    bodyLimit({
      maxSize: MAX_FORM_SUBMISSION_BYTES,
      onError: () => {
        throw new AppError('PAYLOAD_TOO_LARGE', { detail: 'A form submission is at most 256 KB.' });
      },
    })
  );
  for (const [path, name] of [
    ['/api/forms/:formToken/submissions', 'submit'],
    ['/api/forms/:formToken/attachments', 'upload'],
  ] as const) {
    routes.use(
      path,
      rateLimit({
        limit: config.formSubmitRateLimit,
        windowMs: SUBMIT_WINDOW_MS,
        key: (c) => `${name}:${hashShareToken(tokenOf(c))}:${ip(c)}`,
      })
    );
    routes.use(
      path,
      rateLimit({
        limit: config.formSubmitRateLimit * FORM_LIMIT_PER_FORM_FACTOR,
        windowMs: SUBMIT_WINDOW_MS,
        key: (c) => `${name}:${hashShareToken(tokenOf(c))}`,
      })
    );
  }

  const f = contracts.forms;
  routes.endpoint(f.form, 'public', async (c, { params }) => {
    ready();
    let workspaceId = '';
    const form = await withFormShare(db, params.formToken, async (ctx) => {
      workspaceId = ctx.workspaceId;
      const loaded = await loadForm(ctx);
      const entitlements = await c.var.edition.entitlements.forWorkspace(ctx.workspaceId, ctx.tx);
      return publicForm(loaded, verify ? siteKey : null, await formAccepting(loaded, entitlements));
    });
    // At the plan's records per base: the page says so, and the owners hear about it.
    if (!form.accepting) await requestUsageCheck(db, deps.jobs, workspaceId, c.var.logger);
    return form;
  });

  // A link field's picker: only the records of the view the form's creator chose.
  routes.endpoint(f.linkRecords, 'public', async (_c, { params, query }) => {
    ready();
    return withFormShare(db, params.formToken, async (ctx) =>
      formLinkPage(await loadForm(ctx), params.fieldId, query)
    );
  });

  routes.endpoint(f.submit, 'public', async (c, { params, body }) => {
    ready();
    if (verify) {
      // Checked before the transaction: a refusal costs no database work.
      const passed = body.captchaToken
        ? await verify({
            token: body.captchaToken,
            remoteIp: ip(c),
            idempotencyKey: body.submissionId,
          })
        : false;
      if (!passed) {
        throw new AppError('CAPTCHA_FAILED', {
          detail: 'The CAPTCHA check failed. Try it again, then submit.',
        });
      }
    }
    let workspaceId = '';
    try {
      const { submitted } = await withFormShare(
        db,
        params.formToken,
        async (ctx) => {
          workspaceId = ctx.workspaceId;
          return submitForm(
            await loadForm(ctx),
            body,
            await c.var.edition.entitlements.forWorkspace(ctx.workspaceId, ctx.tx)
          );
        },
        { write: true }
      );
      return { submitted };
    } catch (err) {
      // Refused at the plan's records per base: the owners hear about it.
      if (err instanceof AppError && err.code === 'QUOTA_EXCEEDED' && workspaceId) {
        await requestUsageCheck(db, deps.jobs, workspaceId, c.var.logger);
      }
      throw err;
    }
  });

  routes.endpoint(f.upload, 'public', async (c, { params, body }) => {
    ready();
    return withFormShare(
      db,
      params.formToken,
      async (ctx) =>
        createFormUpload(
          await loadForm(ctx),
          deps.store,
          body,
          await c.var.edition.entitlements.forWorkspace(ctx.workspaceId, ctx.tx)
        ),
      { write: true }
    );
  });

  routes.endpoint(f.confirmUpload, 'public', async (_c, { params }) => {
    ready();
    const { row, confirmed, workspaceId } = await withFormShare(
      db,
      params.formToken,
      async (ctx) => ({
        ...(await confirmFormUpload(
          await loadForm(ctx),
          deps.store,
          params.attachmentId,
          deps.scanning
        )),
        workspaceId: ctx.workspaceId,
      }),
      { write: true }
    );
    if (confirmed && row.status === 'ready') {
      deps.thumbnails.enqueue({ workspaceId, userId: FORM_SUBJECT.userId, attachmentId: row.id });
    }
    return toValue(row);
  });

  routes.public(downloads.formImage.method, downloads.formImage.path, async (c) => {
    ready();
    const token = c.req.param('formToken') ?? '';
    const image = c.req.param('image') ?? '';
    const url = await withFormShare(db, token, async (ctx) =>
      formImageUrl(await loadForm(ctx), deps.store, image)
    );
    c.header('cache-control', 'private, no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.redirect(url, 302);
  });
}
