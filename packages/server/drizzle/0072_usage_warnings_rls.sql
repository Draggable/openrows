-- Plan-limit warnings (#130): row-level security for the sent warnings, and the SECURITY DEFINER
-- function listing the live workspaces the worker's `usage.warnings` checks (ids only; each is
-- then read in its tenant's scope). Hand-written, like 0069.

ALTER TABLE usage_warnings_sent ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE usage_warnings_sent FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON usage_warnings_sent
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Live workspaces after `p_after` (by id), a page at a time.
CREATE FUNCTION usage_warning_workspaces(p_after uuid, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT w.id FROM workspaces w
   WHERE w.deleted_at IS NULL AND (p_after IS NULL OR w.id > p_after)
   ORDER BY w.id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION usage_warning_workspaces(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION usage_warning_workspaces(uuid, integer) TO openrows_app;
