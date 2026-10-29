import {
  BUILT_IN_TEMPLATES,
  contracts,
  downloads,
  findTemplate,
  MAX_TEMPLATE_TABLES,
  templateSummary,
} from '@openrows/shared';
import type { RouteRegistry } from '../authz/routes.js';
import { safeFileName } from '../import-export/export.js';
import { AppError } from '../lib/errors.js';
import { readHeader } from '../snapshots/writer.js';
import { baseToTemplate } from './export.js';
import { installTemplate } from './install.js';

const notFound = () => new AppError('NOT_FOUND', { detail: 'No such template.' });

/**
 * Templates: the gallery of built-in templates (static, for any signed-in person), a new
 * base from one (`base:create` in the workspace) and "Save as template" (`base:duplicate`: what
 * a duplicate copies, as a JSON file; sessions only).
 */
export function templateRoutes(routes: RouteRegistry) {
  const t = contracts.templates;
  const summaries = { templates: BUILT_IN_TEMPLATES.map(templateSummary) };

  routes.endpoint(t.list, 'session', () => summaries);

  routes.endpoint(t.get, 'session', (_c, { params }) => {
    const template = findTemplate(params.slug);
    if (!template) throw notFound();
    return template;
  });

  routes.endpoint(
    t.install,
    { resource: 'workspace', action: 'base:create' },
    async (c, { body }) => {
      const { tx, resource, principal, edition } = c.var;
      const template = findTemplate(body.slug);
      if (!template) throw notFound();
      const entitlements = await edition.entitlements.forWorkspace(resource.workspaceId, tx);
      const base = await installTemplate(
        { tx, workspaceId: resource.workspaceId, userId: principal.user.id },
        template,
        { name: body.name, role: resource.role, entitlements }
      );
      c.var.logger.info({ baseId: base.id, template: template.slug }, 'template installed');
      return base;
    }
  );

  const save = downloads.baseTemplate;
  routes.resource(
    save.method,
    save.path,
    { resource: 'base', action: 'base:duplicate', token: null },
    async (c) => {
      const { tx, resource } = c.var;
      save.query.parse(c.req.query());
      const { head } = await readHeader(tx, resource.workspaceId, resource.id);
      if (head.tables.length > MAX_TEMPLATE_TABLES) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `A template holds at most ${MAX_TEMPLATE_TABLES} tables; this base has ${head.tables.length}.`,
        });
      }
      const template = await baseToTemplate(tx, resource.workspaceId, resource.id);
      const filename = `${safeFileName(template.name)}.openrows-template.json`;
      const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
      return c.body(JSON.stringify(template, null, 2), 200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
    }
  );
}
