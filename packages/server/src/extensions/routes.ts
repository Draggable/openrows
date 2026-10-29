import { contracts, roleAllows } from '@openrows/shared';
import { bodyLimit } from 'hono/body-limit';
import type { RouteRegistry } from '../authz/routes.js';
import { AppError } from '../lib/errors.js';
import {
  type CustomBundlePolicy,
  deleteExtension,
  type ExtensionContext,
  getExtensionBundle,
  installExtension,
  listExtensions,
  mayInstallCustom,
  reorderExtensions,
  setExtensionSettings,
  updateExtension,
} from './service.js';

/** Request bodies: an install carries a bundle of up to 1 MB of text (4 MB as UTF-8 JSON). */
const INSTALL_BODY_LIMIT = 4 * 1024 * 1024;
const SETTINGS_BODY_LIMIT = 256 * 1024;

/**
 * A base's extension panel: anyone on the base sees it (`base:read_extensions`; the
 * extensions read and write data as the viewer, with the viewer's rights), creators install,
 * arrange and remove extensions (`base:manage_extensions`), editors change their settings
 * (`base:configure_extensions`). Third-party bundles follow EXTENSIONS_CUSTOM_BUNDLES. Sessions
 * only; resource routes on the base in the path, so other bases' and tenants' ids are 404s.
 */
export function extensionRoutes(
  routes: RouteRegistry,
  deps: { customBundles: CustomBundlePolicy }
) {
  const x = contracts.extensions;
  const read = { resource: 'base', action: 'base:read_extensions', token: null } as const;
  const manage = { resource: 'base', action: 'base:manage_extensions', token: null } as const;
  const configure = {
    resource: 'base',
    action: 'base:configure_extensions',
    token: null,
  } as const;

  const tooLarge = (detail: string) => () => {
    throw new AppError('PAYLOAD_TOO_LARGE', { detail });
  };
  routes.use(
    x.install.path,
    bodyLimit({ maxSize: INSTALL_BODY_LIMIT, onError: tooLarge('An extension takes up to 4 MB.') })
  );
  routes.use(
    x.settings.path,
    bodyLimit({
      maxSize: SETTINGS_BODY_LIMIT,
      onError: tooLarge("An extension's settings take up to 256 KB."),
    })
  );

  const context = (c: {
    var: {
      tx: ExtensionContext['tx'];
      resource: { id: string; workspaceId: string; role: ExtensionContext['role'] };
      principal: { user: { id: string } };
    };
  }): ExtensionContext => ({
    tx: c.var.tx,
    workspaceId: c.var.resource.workspaceId,
    baseId: c.var.resource.id,
    userId: c.var.principal.user.id,
    role: c.var.resource.role,
  });

  const listOf = async (c: Parameters<typeof context>[0]) => {
    const role = c.var.resource.role;
    return {
      extensions: await listExtensions(c.var.tx, c.var.resource.id),
      canManage: !!role && roleAllows(role, 'base:manage_extensions'),
      canConfigure: !!role && roleAllows(role, 'base:configure_extensions'),
      canInstallCustom: mayInstallCustom(deps.customBundles, role),
    };
  };

  routes.endpoint(x.list, read, async (c) => listOf(c));

  routes.endpoint(x.bundle, read, async (c, { params }) =>
    getExtensionBundle(c.var.tx, c.var.resource.id, params.extensionId)
  );

  routes.endpoint(x.install, manage, async (c, { body }) => {
    const installed = await installExtension(context(c), body, deps.customBundles);
    c.var.logger.info(
      { extensionId: installed.id, builtIn: installed.builtIn },
      'extension installed'
    );
    return installed;
  });

  routes.endpoint(x.update, manage, async (c, { params, body }) =>
    updateExtension(context(c), params.extensionId, body)
  );

  routes.endpoint(x.reorder, manage, async (c, { body }) => {
    await reorderExtensions(context(c), body.ids);
    return listOf(c);
  });

  routes.endpoint(x.settings, configure, async (c, { params, body }) =>
    setExtensionSettings(context(c), params.extensionId, body.settings)
  );

  routes.endpoint(x.delete, manage, async (c, { params }) => {
    await deleteExtension(context(c), params.extensionId);
    c.var.logger.info({ extensionId: params.extensionId }, 'extension removed');
    return null;
  });
}
