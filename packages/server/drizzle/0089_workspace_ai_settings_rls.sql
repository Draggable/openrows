-- A workspace's own AI provider and encrypted key (#148). Hand-written, like 0003_rls.sql.
ALTER TABLE workspace_ai_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_ai_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_ai_settings
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
