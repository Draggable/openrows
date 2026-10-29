-- Row-level security for record comments and their reactions (#92). Hand-written, like
-- 0003_rls.sql.
ALTER TABLE record_comments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE record_comments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON record_comments
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE record_comment_reactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE record_comment_reactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON record_comment_reactions
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
