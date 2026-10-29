-- Base-only collaborators (#91). Hand-written, like 0003_rls.sql.

-- "List my workspaces" also shows a workspace where the user collaborates on some bases only
-- (a base_members row, which self_read on base_members shows them). The server lists only those
-- bases to them; every other route still goes through authz_resolve.
CREATE POLICY base_member_read ON workspaces FOR SELECT
  USING (id IN (SELECT bm.workspace_id FROM base_members bm WHERE bm.user_id = (SELECT app_user_id())));
--> statement-breakpoint

-- As in 0007, plus: a base invitation whose base is in the trash finds nothing.
CREATE OR REPLACE FUNCTION invitation_by_token(p_token_hash text)
  RETURNS TABLE (id uuid, workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT i.id, i.workspace_id
      FROM workspace_invitations i
      JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
      LEFT JOIN bases b ON b.workspace_id = i.workspace_id AND b.id = i.base_id
     WHERE i.token_hash = p_token_hash
       AND (i.base_id IS NULL OR b.deleted_at IS NULL)
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION invitation_by_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION invitation_by_token(text) TO openrows_app;
