-- Row-level security, the runtime role and the authorization resolver (ADR-002, #13).
-- Hand-written: drizzle-kit can't express FORCE ROW LEVEL SECURITY, grants or functions.
-- Role setup for each environment: docs/deploy/database.md.

-- authz_resolve below is SECURITY DEFINER and must see every tenant's rows, so the role that
-- runs migrations (and owns the schema) has to bypass RLS. Fail loudly rather than install a
-- resolver that silently finds nothing.
DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'OpenRows migrations must run as a superuser or a role with BYPASSRLS (see docs/deploy/database.md)';
  END IF;
END $$;
--> statement-breakpoint

-- The API and worker connect as openrows_app: not a superuser, no BYPASSRLS, owns nothing, so
-- every policy applies to it. Created without LOGIN when missing; the migrate entrypoint
-- (OPENROWS_APP_DB_PASSWORD) or a DBA gives it a password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'openrows_app') THEN
    CREATE ROLE openrows_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO openrows_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO openrows_app;
--> statement-breakpoint
-- Tables created by later migrations (run by the same role) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO openrows_app;
--> statement-breakpoint

-- The request's workspace and user, set per transaction with set_config(..., true) (SET LOCAL)
-- by src/authz/scope.ts. Unset means NULL, which no policy matches: forgetting fails closed.
CREATE FUNCTION app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- One tenant policy per table. `(SELECT ...)` makes it an InitPlan, evaluated once per query.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspaces
  USING (id = (SELECT app_workspace_id()))
  WITH CHECK (id = (SELECT app_workspace_id()));
--> statement-breakpoint
-- "List my workspaces" works before a workspace is chosen.
CREATE POLICY member_read ON workspaces FOR SELECT
  USING (id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = (SELECT app_user_id())));
--> statement-breakpoint

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_members
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY self_read ON workspace_members FOR SELECT
  USING (user_id = (SELECT app_user_id()));
--> statement-breakpoint

ALTER TABLE base_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE base_members FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON base_members
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY self_read ON base_members FOR SELECT
  USING (user_id = (SELECT app_user_id()));
--> statement-breakpoint

ALTER TABLE bases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE bases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON bases
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

ALTER TABLE tables ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tables FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON tables
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

ALTER TABLE fields ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE fields FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON fields
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

ALTER TABLE views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE views FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON views
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Resolves a resource to its workspace, its base and the user's roles there, in one query and
-- before any workspace is set (src/authz/resolve.ts). SECURITY DEFINER, so it reads past RLS;
-- it returns only ids and the given user's own roles. No row: the resource doesn't exist or is
-- in the trash (soft-deleted itself or through a parent).
CREATE FUNCTION authz_resolve(p_kind text, p_id uuid, p_user_id uuid)
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION authz_resolve(text, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION authz_resolve(text, uuid, uuid) TO openrows_app;
