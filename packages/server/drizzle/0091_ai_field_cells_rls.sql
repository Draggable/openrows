-- AI fields' per-record generation state (#149). Hand-written, like 0003_rls.sql.
ALTER TABLE ai_field_cells ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_field_cells FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON ai_field_cells
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
