-- A base's installed extensions (#153). Hand-written, like 0003_rls.sql.
ALTER TABLE base_extensions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE base_extensions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON base_extensions
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
