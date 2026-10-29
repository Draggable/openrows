import { contracts } from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';
import type { Jobs } from '../jobs/send.js';
import { loadOwnJob } from '../jobs/status.js';
import { AppError } from '../lib/errors.js';
import {
  type AirtableDeps,
  airtableClient,
  cancelAirtableImport,
  listAirtableImports,
  startAirtableImports,
  toAirtableImport,
} from './import.js';

/**
 * "Import from Airtable": workspace creators (`base:create`), sessions only (a personal
 * access token can't start one). The Airtable token is in the body, never a URL; it is checked
 * against Airtable, then kept encrypted in each job row until the job ends, and never answered
 * or logged. Only who started an import reads it, or cancels it.
 */
export function airtableRoutes(routes: RouteRegistry, deps: AirtableDeps & { jobs: Jobs }) {
  const a = contracts.airtable;
  const access = { resource: 'workspace', action: 'base:create', token: null } as const;

  routes.endpoint(a.bases, access, async (_c, { body }) => ({
    bases: await airtableClient(deps, body.token).listBases(),
  }));

  routes.endpoint(a.create, access, async (c, { body }) => {
    const { tx, resource, principal } = c.var;
    // The bases' names, and proof the token reads them, before anything is created.
    const readable = new Map(
      (await airtableClient(deps, body.token).listBases()).map((b) => [b.id, b])
    );
    const missing = body.baseIds.flatMap((id, i) =>
      readable.has(id) ? [] : [{ path: `baseIds.${i}`, message: "The token can't read this base." }]
    );
    if (missing.length) {
      throw new AppError('VALIDATION_FAILED', {
        detail: "The token can't read every base you picked.",
        extensions: { errors: missing },
      });
    }
    const picked = body.baseIds.flatMap((id) => readable.get(id) ?? []);
    const imports = await startAirtableImports(
      { tx, workspaceId: resource.workspaceId, userId: principal.user.id, role: resource.role },
      { jobs: deps.jobs, cipher: deps.cipher },
      body.token,
      picked
    );
    return { imports };
  });

  routes.endpoint(a.list, access, async (c) => ({
    imports: await listAirtableImports(c.var.tx, c.var.principal.user.id),
  }));

  routes.endpoint(a.get, access, async (c, { params }) => {
    const job = await loadOwnJob(
      c.var.tx,
      { id: params.importId, kind: 'airtable', userId: c.var.principal.user.id },
      'No such import.'
    );
    return toAirtableImport(job);
  });

  routes.endpoint(a.cancel, access, async (c, { params }) => {
    const job = await loadOwnJob(
      c.var.tx,
      { id: params.importId, kind: 'airtable', userId: c.var.principal.user.id },
      'No such import.'
    );
    return toAirtableImport(await cancelAirtableImport(c.var.tx, job));
  });
}
