-- A base's saved scripts (#152). Hand-written, like 0003_rls.sql.
ALTER TABLE base_scripts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE base_scripts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON base_scripts
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
