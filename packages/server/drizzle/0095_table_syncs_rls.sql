-- Synced tables (#154). Hand-written, like 0003_rls.sql.
ALTER TABLE table_syncs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE table_syncs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON table_syncs
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE table_sync_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE table_sync_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON table_sync_runs
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Active scheduled syncs whose next run is due, oldest first, for the scheduler job (which then
-- works in each one's tenant scope): ids and times only.
CREATE FUNCTION table_syncs_due(p_limit integer)
  RETURNS TABLE (id uuid, workspace_id uuid, next_run_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT s.id, s.workspace_id, s.next_run_at
    FROM table_syncs s
    JOIN tables t ON t.workspace_id = s.workspace_id AND t.id = s.table_id
    JOIN bases b ON b.workspace_id = s.workspace_id AND b.id = s.base_id
   WHERE s.status = 'active' AND s.schedule <> 'manual'
     AND s.next_run_at IS NOT NULL AND s.next_run_at <= now()
     AND t.deleted_at IS NULL AND b.deleted_at IS NULL
   ORDER BY s.next_run_at
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION table_syncs_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION table_syncs_due(integer) TO openrows_app;
