-- Automation triggers and actions (#110): row-level security for the daily email counts, and the
-- lookup of a webhook-received trigger by its URL token for the public /hooks/a/<token> route
-- (which has no tenant scope yet). Hand-written, like 0055_automations_rls.sql.
ALTER TABLE automation_email_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE automation_email_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON automation_email_counts
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- The enabled webhook-received automation with this token hash in a live base and workspace:
-- its id and workspace only (the route then works in that workspace's scope).
CREATE FUNCTION automation_hook_resolve(p_token_hash text)
  RETURNS TABLE (id uuid, workspace_id uuid, token_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT a.id, a.workspace_id, a.hook_token_hash
    FROM automations a
    JOIN workspaces w ON w.id = a.workspace_id AND w.deleted_at IS NULL
    JOIN bases b ON b.workspace_id = a.workspace_id AND b.id = a.base_id AND b.deleted_at IS NULL
   WHERE a.hook_token_hash = p_token_hash
     AND a.enabled AND a.trigger_type = 'webhookReceived'
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION automation_hook_resolve(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION automation_hook_resolve(text) TO openrows_app;
