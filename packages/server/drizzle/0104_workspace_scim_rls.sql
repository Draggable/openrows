-- SCIM provisioning (#159). Hand-written, like 0003_rls.sql.
ALTER TABLE workspace_scim_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_scim_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_scim_settings
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE workspace_scim_users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_scim_users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_scim_users
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE workspace_scim_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_scim_groups FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_scim_groups
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE workspace_scim_group_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_scim_group_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_scim_group_members
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- A SCIM request names no workspace: its bearer token does. The token's SHA-256 resolves here
-- (live workspaces only), before any workspace scope; nothing else of the settings is read.
CREATE FUNCTION scim_token_resolve(p_hash text)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT s.workspace_id
    FROM workspace_scim_settings s
    JOIN workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
   WHERE s.token_hash = p_hash
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION scim_token_resolve(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION scim_token_resolve(text) TO openrows_app;
--> statement-breakpoint

-- At sign-in (no workspace in scope yet): the workspaces that provisioned this verified address
-- and wait for its account, so the account joins them.
CREATE FUNCTION scim_pending_for_email(p_email text)
  RETURNS TABLE (workspace_id uuid, scim_user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT u.workspace_id, u.id
    FROM workspace_scim_users u
    JOIN workspaces w ON w.id = u.workspace_id AND w.deleted_at IS NULL
   WHERE u.email = lower(p_email) AND u.user_id IS NULL AND u.active
   LIMIT 50
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION scim_pending_for_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION scim_pending_for_email(text) TO openrows_app;
