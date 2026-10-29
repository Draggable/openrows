import { z } from 'zod';

/**
 * Data residency. A region is one complete OpenRows stack (api, worker, Postgres, the
 * attachments bucket and its backups) at its own origin; a workspace lives in exactly one, chosen
 * when it is created. A self-hosted install is one region.
 */

/** A region's id: `eu`, `us`. */
export const regionIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,15}$/, 'Not a region id');

export const RegionSchema = z.object({
  id: regionIdSchema,
  /** For people: "European Union". */
  name: z.string().min(1).max(60),
  /** Where its app runs (the origin the workspace's links point at). */
  appUrl: z.url(),
});
export type Region = z.infer<typeof RegionSchema>;

export const RegionsSchema = z.object({
  /** The region this stack serves. */
  current: regionIdSchema,
  /** Every region, this one included, in display order. */
  regions: z.array(RegionSchema),
  /**
   * Whether the caller may create a workspace in another region: they own a workspace whose plan
   * has `dataResidency` (Enterprise) and this is the home region.
   */
  createElsewhere: z.boolean(),
});
export type Regions = z.infer<typeof RegionsSchema>;

export const createRegionWorkspaceSchema = z.strictObject({
  name: z.string().trim().min(1).max(255),
});
export type CreateRegionWorkspace = z.infer<typeof createRegionWorkspaceSchema>;

export const RegionWorkspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  region: regionIdSchema,
  /** The workspace in its region's app; the person signs in there with the same account. */
  url: z.url(),
});
export type RegionWorkspace = z.infer<typeof RegionWorkspaceSchema>;
