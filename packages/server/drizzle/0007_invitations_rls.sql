-- Row-level security for workspace invitations and the token lookup (#16). Hand-written, like
-- 0003_rls.sql.
ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_invitations
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Finds an invitation by the SHA-256 of its emailed token before any workspace is in scope
-- (the invitee isn't a member yet). SECURITY DEFINER, so it reads past RLS; it returns only the
-- ids, and the server then scopes the transaction to that workspace. No row: unknown token, or
-- the workspace is in the trash.
CREATE FUNCTION invitation_by_token(p_token_hash text)
  RETURNS TABLE (id uuid, workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT i.id, i.workspace_id
      FROM workspace_invitations i
      JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
     WHERE i.token_hash = p_token_hash
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION invitation_by_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION invitation_by_token(text) TO openrows_app;
