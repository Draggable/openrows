-- Row-level security for sync connector accounts and connector sources (#156). Hand-written, like
-- 0040_personal_access_tokens_rls.sql.
--
-- An account belongs to a person, not a workspace: only its owner (app.user_id) lists, connects
-- and disconnects it. A sync run reads its creator's account in a scope with app.user_id set to
-- the creator (the run's own scope), so it never sees anyone else's.
ALTER TABLE sync_connector_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_connector_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner ON sync_connector_accounts
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint
-- A connector source (#156) names its connector and has no secret of its own: the sync's
-- creator's connected account reads it.
ALTER TABLE table_syncs DROP CONSTRAINT table_syncs_source_check;
--> statement-breakpoint
ALTER TABLE table_syncs ADD CONSTRAINT table_syncs_source_check CHECK (
  (source_kind = 'table' AND source_workspace_id IS NOT NULL AND source_base_id IS NOT NULL
    AND source_table_id IS NOT NULL)
  OR (source_kind IN ('csv', 'postgres') AND source_secret IS NOT NULL)
  OR (source_kind = 'connector' AND source_secret IS NULL
    AND jsonb_typeof(source_config -> 'connector') = 'string')
);
