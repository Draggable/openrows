-- Per-workspace single sign-on (#158). Hand-written, like 0003_rls.sql.
ALTER TABLE workspace_sso_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_sso_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_sso_connections
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE workspace_sso_domains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_sso_domains FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_sso_domains
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Home-realm discovery and the sign-in check happen before any workspace scope (the address's
-- domain or the identity provider names the workspace), so they read through these two: only
-- verified domains, only what the sign-in needs, no tokens.

-- The single sign-on of a verified domain, if a workspace has it.
CREATE FUNCTION sso_resolve_domain(p_domain text)
  RETURNS TABLE (workspace_id uuid, alias text, enabled boolean, require_sso boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT c.workspace_id, c.alias, c.enabled, c.require_sso
    FROM workspace_sso_domains d
    JOIN workspace_sso_connections c ON c.workspace_id = d.workspace_id
    JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
   WHERE d.domain = lower(p_domain) AND d.verified_at IS NOT NULL
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sso_resolve_domain(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sso_resolve_domain(text) TO openrows_app;
--> statement-breakpoint

-- The workspace connection behind a Keycloak identity provider alias, with its verified domains.
CREATE FUNCTION sso_resolve_alias(p_alias text)
  RETURNS TABLE (workspace_id uuid, enabled boolean, jit boolean, default_role text, domains text[])
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT c.workspace_id, c.enabled, c.jit, c.default_role,
         coalesce(array_agg(d.domain ORDER BY d.domain) FILTER (WHERE d.domain IS NOT NULL), '{}')
    FROM workspace_sso_connections c
    JOIN workspaces w ON w.id = c.workspace_id AND w.deleted_at IS NULL
    LEFT JOIN workspace_sso_domains d ON d.workspace_id = c.workspace_id AND d.verified_at IS NOT NULL
   WHERE c.alias = p_alias
   GROUP BY c.workspace_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sso_resolve_alias(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sso_resolve_alias(text) TO openrows_app;
