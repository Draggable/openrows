-- Row-level security for view_record_positions (#39). Hand-written, like 0003_rls.sql.
ALTER TABLE view_record_positions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE view_record_positions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON view_record_positions
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
