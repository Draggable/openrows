-- Row-level security for attachments (#31). Hand-written, like 0003_rls.sql.
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON attachments
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
