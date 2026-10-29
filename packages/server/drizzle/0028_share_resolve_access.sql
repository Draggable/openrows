-- share_resolve for base links, passwords, email domains and the copy/download toggles (#98).
-- Hand-written, like 0026_shares_rls.sql. The return type changes, so the function is replaced.
DROP FUNCTION share_resolve(text);
--> statement-breakpoint

-- Resolves a share token's SHA-256 (hex) to its live share, before any workspace is known (the
-- public routes have no session; src/shares/service.ts). SECURITY DEFINER, so it reads past RLS;
-- it returns only what the server needs to check the link's password and domains and to scope
-- its transaction. No row, the same for every reason (no oracle): no such token, revoked,
-- expired, the base or workspace in the trash, for a view link the view or its table in the
-- trash or a personal view its maker no longer owns, or a maker who can't share any more (a
-- creator or owner of the workspace, or a creator of the base).
CREATE FUNCTION share_resolve(p_token_hash text)
  RETURNS TABLE (share_id uuid, workspace_id uuid, base_id uuid, kind text, view_id uuid,
                 token_hash text, expires_at timestamptz, password_hash text,
                 password_version integer, allowed_domains text[], allow_copy boolean,
                 allow_download boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT s.id, s.workspace_id, s.base_id, s.kind, s.view_id, s.token_hash, s.expires_at,
           s.password_hash, s.password_version, s.allowed_domains, s.allow_copy,
           s.allow_download
      FROM shares s
      JOIN workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
      JOIN bases b ON b.workspace_id = s.workspace_id AND b.id = s.base_id AND b.deleted_at IS NULL
      LEFT JOIN views v ON v.workspace_id = s.workspace_id AND v.id = s.view_id
                       AND v.deleted_at IS NULL
      LEFT JOIN tables t ON t.workspace_id = v.workspace_id AND t.id = v.table_id
                        AND t.base_id = s.base_id AND t.deleted_at IS NULL
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND (
         s.kind = 'base'
         OR (s.kind = 'view' AND t.id IS NOT NULL
             AND (NOT v.personal OR v.created_by = s.created_by))
       )
       AND (
         EXISTS (SELECT 1 FROM workspace_members wm
                  WHERE wm.workspace_id = s.workspace_id AND wm.user_id = s.created_by
                    AND wm.role IN ('owner', 'creator'))
         OR EXISTS (SELECT 1 FROM base_members bm
                     WHERE bm.base_id = s.base_id AND bm.user_id = s.created_by
                       AND bm.role = 'creator')
       )
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_resolve(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION share_resolve(text) TO openrows_app;
