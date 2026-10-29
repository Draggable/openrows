-- Row-level security and the worker's functions for base snapshots (#96). Hand-written, like
-- 0022_record_revisions_rls.sql.
ALTER TABLE base_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE base_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON base_snapshots
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE workspaces ADD CONSTRAINT workspaces_snapshot_retention_days_check
  CHECK (snapshot_retention_days BETWEEN 1 AND 365);
--> statement-breakpoint

-- The live bases due an automatic snapshot: none in the last `min_age_hours`, and changed (an
-- outbox event) since their newest snapshot, or ever (within the outbox's retention) when they
-- have none. Oldest snapshot first. Bases of every workspace, so it runs as the schema owner
-- (SECURITY DEFINER) and returns ids only; the worker then works inside each workspace's scope.
CREATE FUNCTION base_snapshots_due(p_limit integer, min_age_hours integer DEFAULT 24)
  RETURNS TABLE (workspace_id uuid, base_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT b.workspace_id, b.id
    FROM bases b
    JOIN workspaces w ON w.id = b.workspace_id AND w.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT max(s.created_at) AS last FROM base_snapshots s WHERE s.base_id = b.id
    ) s ON true
   WHERE b.deleted_at IS NULL
     AND (s.last IS NULL OR s.last < now() - make_interval(hours => min_age_hours))
     AND EXISTS (SELECT 1 FROM outbox o
                  WHERE o.base_id = b.id AND (s.last IS NULL OR o.created_at > s.last))
   ORDER BY s.last NULLS FIRST, b.id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION base_snapshots_due(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION base_snapshots_due(integer, integer) TO openrows_app;
--> statement-breakpoint

-- Deletes up to `p_limit` snapshots older than their workspace's retention and returns their
-- object keys, which the worker then deletes from object storage.
CREATE FUNCTION base_snapshots_prune(p_limit integer)
  RETURNS TABLE (storage_key text)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DELETE FROM base_snapshots
   WHERE id IN (
     SELECT s.id FROM base_snapshots s
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.created_at < now() - make_interval(days => w.snapshot_retention_days)
      LIMIT greatest(p_limit, 0))
  RETURNING base_snapshots.storage_key
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION base_snapshots_prune(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION base_snapshots_prune(integer) TO openrows_app;
