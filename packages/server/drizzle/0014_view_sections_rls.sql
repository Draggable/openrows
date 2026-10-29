-- Row-level security for view_sections (#42). Hand-written, like 0003_rls.sql.
ALTER TABLE view_sections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE view_sections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON view_sections
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- authz_resolve (0003_rls.sql) with personal views (#42): a personal view resolves only for its
-- creator, so every route on it answers 404 to anyone else, as for a view of another tenant.
CREATE OR REPLACE FUNCTION authz_resolve(p_kind text, p_id uuid, p_user_id uuid)
  RETURNS TABLE (workspace_id uuid, base_id uuid, workspace_role text, base_role text)
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
    )
    SELECT target.workspace_id, target.base_id, wm.role, bm.role
      FROM target
      JOIN workspaces w ON w.id = target.workspace_id AND w.deleted_at IS NULL
      LEFT JOIN bases b ON b.workspace_id = target.workspace_id AND b.id = target.base_id
      LEFT JOIN workspace_members wm
        ON wm.workspace_id = target.workspace_id AND wm.user_id = p_user_id
      LEFT JOIN base_members bm ON bm.base_id = target.base_id AND bm.user_id = p_user_id
     WHERE target.base_id IS NULL OR b.deleted_at IS NULL
  $$;
