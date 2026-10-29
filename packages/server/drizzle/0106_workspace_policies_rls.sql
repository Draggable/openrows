-- Workspace policies and member activity (#160). Hand-written, like 0003_rls.sql.
ALTER TABLE workspace_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_policies
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE workspace_member_activity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_member_activity FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_member_activity
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- authz_resolve also answers the workspace's token policy (a personal access token is refused on
-- a workspace that turned them off) and when the user last used the workspace (withResource
-- touches it when it's old). Both are about the resource's workspace and the requesting user only.
DROP FUNCTION authz_resolve(text, uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION authz_resolve(p_kind text, p_id uuid, p_user_id uuid)
  RETURNS TABLE (workspace_id uuid, base_id uuid, workspace_role text, base_role text,
                 suspended boolean, interface_role text, tokens_allowed boolean,
                 last_active_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH target AS (
      SELECT w.id AS workspace_id, NULL::uuid AS base_id
        FROM workspaces w
       WHERE p_kind = 'workspace' AND w.id = p_id
      UNION ALL
      SELECT b.workspace_id, b.id
        FROM bases b
       WHERE p_kind = 'base' AND b.id = p_id
      UNION ALL
      SELECT t.workspace_id, t.base_id
        FROM tables t
       WHERE p_kind = 'table' AND t.id = p_id AND t.deleted_at IS NULL
      UNION ALL
      SELECT t.workspace_id, t.base_id
        FROM fields f
        JOIN tables t ON t.workspace_id = f.workspace_id AND t.id = f.table_id
       WHERE p_kind = 'field' AND f.id = p_id AND f.deleted_at IS NULL AND t.deleted_at IS NULL
      UNION ALL
      SELECT t.workspace_id, t.base_id
        FROM views v
        JOIN tables t ON t.workspace_id = v.workspace_id AND t.id = v.table_id
       WHERE p_kind = 'view' AND v.id = p_id AND v.deleted_at IS NULL AND t.deleted_at IS NULL
         AND (NOT v.personal OR v.created_by = p_user_id)
      UNION ALL
      SELECT i.workspace_id, i.base_id
        FROM interfaces i
       WHERE p_kind = 'interface' AND i.id = p_id
    )
    SELECT target.workspace_id, target.base_id, wm.role, bm.role, w.suspended_at IS NOT NULL,
           im.role, COALESCE(wp.personal_access_tokens, true), wa.last_active_at
      FROM target
      JOIN workspaces w ON w.id = target.workspace_id AND w.deleted_at IS NULL
      LEFT JOIN bases b ON b.workspace_id = target.workspace_id AND b.id = target.base_id
      LEFT JOIN workspace_members wm
        ON wm.workspace_id = target.workspace_id AND wm.user_id = p_user_id
      LEFT JOIN base_members bm ON bm.base_id = target.base_id AND bm.user_id = p_user_id
      LEFT JOIN interface_members im
        ON p_kind = 'interface' AND im.interface_id = p_id AND im.user_id = p_user_id
      LEFT JOIN workspace_policies wp ON wp.workspace_id = target.workspace_id
      LEFT JOIN workspace_member_activity wa
        ON wa.workspace_id = target.workspace_id AND wa.user_id = p_user_id
     WHERE target.base_id IS NULL OR b.deleted_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION authz_resolve(text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authz_resolve(text, uuid, uuid) TO openrows_app;
--> statement-breakpoint

-- Share links stop resolving while the workspace's policy turns them off (view and base links:
-- share_links; form links: public_forms), no row as for every other reason; with embeds off a
-- link has no embed origins, so no other site may frame it.
CREATE OR REPLACE FUNCTION share_resolve(p_token_hash text)
  RETURNS TABLE (share_id uuid, workspace_id uuid, base_id uuid, kind text, view_id uuid,
                 token_hash text, expires_at timestamptz, password_hash text,
                 password_version integer, allowed_domains text[], allow_copy boolean,
                 allow_download boolean, embed_origins text[], allow_restricted_embed boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT s.id, s.workspace_id, s.base_id, s.kind, s.view_id, s.token_hash, s.expires_at,
           s.password_hash, s.password_version, s.allowed_domains, s.allow_copy,
           s.allow_download,
           CASE WHEN COALESCE(wp.embeds, true) THEN s.embed_origins ELSE '{}'::text[] END,
           s.allow_restricted_embed
      FROM shares s
      JOIN workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
                       AND w.suspended_at IS NULL
      JOIN bases b ON b.workspace_id = s.workspace_id AND b.id = s.base_id AND b.deleted_at IS NULL
      LEFT JOIN views v ON v.workspace_id = s.workspace_id AND v.id = s.view_id
                       AND v.deleted_at IS NULL
      LEFT JOIN tables t ON t.workspace_id = v.workspace_id AND t.id = v.table_id
                        AND t.base_id = s.base_id AND t.deleted_at IS NULL
      LEFT JOIN workspace_policies wp ON wp.workspace_id = s.workspace_id
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND (
         s.kind = 'base'
         OR (s.kind IN ('view', 'form') AND t.id IS NOT NULL
             AND (NOT v.personal OR v.created_by = s.created_by)
             AND (s.kind <> 'form' OR v.type = 'form'))
       )
       AND (
         EXISTS (SELECT 1 FROM workspace_members wm
                  WHERE wm.workspace_id = s.workspace_id AND wm.user_id = s.created_by
                    AND wm.role IN ('owner', 'creator'))
         OR EXISTS (SELECT 1 FROM base_members bm
                     WHERE bm.base_id = s.base_id AND bm.user_id = s.created_by
                       AND bm.role = 'creator')
       )
       AND CASE WHEN s.kind = 'form' THEN COALESCE(wp.public_forms, true)
                ELSE COALESCE(wp.share_links, true) END
  $$;
