-- Interfaces (#145): row-level security for interfaces and their pages. Hand-written, like
-- 0055_automations_rls.sql.
ALTER TABLE interfaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE interfaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON interfaces
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE interface_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE interface_pages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON interface_pages
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
