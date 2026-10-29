-- Interface-only collaborators (#147). Hand-written, like 0085_interfaces_rls.sql.
ALTER TABLE interface_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE interface_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON interface_members
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- A request of an interface-only collaborator runs with `app.interface_id` set (withResource on
-- an interface the user reaches through interface_members alone): interfaces, their pages and
-- members then show that interface's rows only, whatever the query asks for. Unset (every other
-- request) it narrows nothing.
CREATE FUNCTION app_interface_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.interface_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE POLICY interface_scope ON interfaces AS RESTRICTIVE
  USING ((SELECT app_interface_id()) IS NULL OR id = (SELECT app_interface_id()));
--> statement-breakpoint
CREATE POLICY interface_scope ON interface_pages AS RESTRICTIVE
  USING ((SELECT app_interface_id()) IS NULL OR interface_id = (SELECT app_interface_id()));
--> statement-breakpoint
CREATE POLICY interface_scope ON interface_members AS RESTRICTIVE
  USING ((SELECT app_interface_id()) IS NULL OR interface_id = (SELECT app_interface_id()));
--> statement-breakpoint

-- authz_resolve learns the `interface` kind and answers the user's interface role there
-- (interface_members): it counts on that interface only, so an interface-only collaborator
-- resolves to no role on the base, its tables, fields, views and other interfaces.
DROP FUNCTION authz_resolve(text, uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION authz_resolve(p_kind text, p_id uuid, p_user_id uuid)
  RETURNS TABLE (workspace_id uuid, base_id uuid, workspace_role text, base_role text,
                 suspended boolean, interface_role text)
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
           im.role
      FROM target
      JOIN workspaces w ON w.id = target.workspace_id AND w.deleted_at IS NULL
      LEFT JOIN bases b ON b.workspace_id = target.workspace_id AND b.id = target.base_id
      LEFT JOIN workspace_members wm
        ON wm.workspace_id = target.workspace_id AND wm.user_id = p_user_id
      LEFT JOIN base_members bm ON bm.base_id = target.base_id AND bm.user_id = p_user_id
      LEFT JOIN interface_members im
        ON p_kind = 'interface' AND im.interface_id = p_id AND im.user_id = p_user_id
     WHERE target.base_id IS NULL OR b.deleted_at IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION authz_resolve(text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authz_resolve(text, uuid, uuid) TO openrows_app;
--> statement-breakpoint

-- "Shared with me" on Home (#147): the interfaces someone is an interface-only collaborator of,
-- across workspaces (RLS shows one workspace at a time), with at least one published page, in
-- live bases and workspaces.
CREATE FUNCTION interfaces_shared_with(p_user_id uuid)
  RETURNS TABLE (id uuid, name text, base_id uuid, base_name text, workspace_name text,
                 role text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT i.id, i.name, b.id, b.name, w.name, im.role
      FROM interface_members im
      JOIN interfaces i ON i.workspace_id = im.workspace_id AND i.id = im.interface_id
      JOIN bases b ON b.workspace_id = i.workspace_id AND b.id = i.base_id
                  AND b.deleted_at IS NULL
      JOIN workspaces w ON w.id = i.workspace_id AND w.deleted_at IS NULL
     WHERE im.user_id = p_user_id
       AND EXISTS (SELECT 1 FROM interface_pages p
                    WHERE p.workspace_id = i.workspace_id AND p.interface_id = i.id
                      AND p.published IS NOT NULL)
     ORDER BY lower(i.name), i.id
     LIMIT 200
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION interfaces_shared_with(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION interfaces_shared_with(uuid) TO openrows_app;
