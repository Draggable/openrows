import { contracts, type Region } from '@openrows/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { audit } from '../audit/record.js';
import type { RouteRegistry } from '../authz/routes.js';
import { inScope } from '../authz/scope.js';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { workspaceMembers, workspaces } from '../db/schema.js';
import { type Edition, RegionUnavailableError } from '../edition/types.js';
import { AppError } from '../lib/errors.js';
import { featureRequired } from '../usage/quota.js';

/** Owned workspaces looked at for a plan with data residency. */
const OWNED_WORKSPACES_CHECKED = 50;

/** The regions with their app origins: the OSS edition's one region is this APP_URL. */
export function listRegions(edition: Edition, config: Pick<Config, 'appUrl'>): Region[] {
  return edition.residency.regions.map((r) => ({
    id: r.id,
    name: r.name,
    appUrl: r.appUrl ?? config.appUrl,
  }));
}

/**
 * The first live workspace `userId` owns whose plan has `dataResidency` (Enterprise), with that
 * plan's id; null without one. Each is read in its own scope, as the entitlements need.
 */
export async function residencyWorkspace(
  db: Database,
  edition: Edition,
  userId: string
): Promise<{ id: string; plan: string } | null> {
  const owned = await inScope(db, { userId }, (tx) =>
    tx
      .select({ id: workspaces.id })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.role, 'owner'),
          isNull(workspaces.deletedAt),
          isNull(workspaces.suspendedAt)
        )
      )
      .orderBy(asc(workspaces.createdAt))
      .limit(OWNED_WORKSPACES_CHECKED)
  );
  for (const { id } of owned) {
    const entitlements = await inScope(db, { userId, workspaceId: id }, (tx) =>
      edition.entitlements.forWorkspace(id, tx)
    );
    if (entitlements.has('dataResidency')) return { id, plan: entitlements.plan };
  }
  return null;
}

/**
 * Data residency: the regions, and creating a workspace in another region's stack. Each
 * region is a stack of its own (the edition's DataResidency); this stack keeps nothing of a
 * workspace created elsewhere but the audit entry in the caller's Enterprise workspace.
 */
export function regionRoutes(
  routes: RouteRegistry,
  { db, config }: { db: Database; config: Config }
) {
  const r = contracts.regions;

  routes.endpoint(r.list, 'session', async (c) => {
    const { residency } = c.var.edition;
    const regions = listRegions(c.var.edition, config);
    const elsewhere =
      residency.selfServe && residency.createElsewhere !== undefined && regions.length > 1;
    return {
      current: residency.current.id,
      regions,
      createElsewhere:
        elsewhere &&
        (await residencyWorkspace(db, c.var.edition, c.var.principal.user.id)) !== null,
    };
  });

  routes.endpoint(r.createWorkspace, 'session', async (c, { params, body }) => {
    const { edition, principal } = c.var;
    const { residency } = edition;
    const region = residency.regions.find((x) => x.id === params.regionId);
    if (!region || !residency.createElsewhere || !residency.selfServe) {
      throw new AppError('NOT_FOUND', { detail: 'No such region.' });
    }
    if (region.id === residency.current.id) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'This is the current region: create the workspace here.',
      });
    }
    const user = principal.user;
    const home = await residencyWorkspace(db, edition, user.id);
    if (!home) throw featureRequired('dataResidency');

    const workspaceId = uuidv7();
    let created: { id: string; url: string };
    try {
      created = await residency.createElsewhere({
        workspaceId,
        region: region.id,
        name: body.name,
        owner: {
          issuer: user.oidcIssuer,
          subject: user.oidcSubject,
          email: user.email,
          emailVerified: user.emailVerified,
          name: user.name,
        },
        plan: home.plan,
      });
    } catch (err) {
      if (!(err instanceof RegionUnavailableError)) throw err;
      c.var.logger.warn({ region: region.id, err: err.message }, 'region unavailable');
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: `The ${region.name} region can't be reached. Try again later.`,
      });
    }
    // The Enterprise workspace's audit log names the region and the new workspace's id.
    await inScope(db, { userId: user.id, workspaceId: home.id }, (tx) =>
      audit(c, tx, {
        workspaceId: home.id,
        action: 'workspace.create_in_region',
        target: { type: 'workspace', id: created.id, name: body.name },
        summary: { after: { region: region.id } },
      })
    );
    return { id: created.id, name: body.name, region: region.id, url: created.url };
  });
}
