-- The hosted ops console (#134). The console's routes live in ee/ and reach across tenants only
-- through the SECURITY DEFINER functions below, each of which first checks that `app.user_id`
-- is a live system admin (`users.is_system_admin`, set only from OPENROWS_SYSTEM_ADMINS or by
-- hand in the database). Per-workspace reads (members, webhooks, usage) use the normal tenant
-- scope instead.

-- Whether `app.user_id` is a system admin who isn't deleted or suspended.
CREATE FUNCTION app_is_system_admin() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (SELECT 1 FROM users u
                    WHERE u.id = nullif(current_setting('app.user_id', true), '')::uuid
                      AND u.is_system_admin AND u.deleted_at IS NULL AND u.suspended_at IS NULL)
  $$;
--> statement-breakpoint
CREATE FUNCTION admin_assert() RETURNS void
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF NOT app_is_system_admin() THEN
    RAISE EXCEPTION 'not a system admin' USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint

-- The append-only audit log: INSERT and SELECT only, under RLS; no role may change or remove an
-- entry (the trigger also binds the table's owner).
REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit_log FROM openrows_app;
--> statement-breakpoint
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE admin_audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY admin_read ON admin_audit_log FOR SELECT USING ((SELECT app_is_system_admin()));
--> statement-breakpoint
CREATE POLICY admin_insert ON admin_audit_log FOR INSERT
  WITH CHECK (admin_id = (SELECT app_user_id()) AND (SELECT app_is_system_admin()));
--> statement-breakpoint
-- A user's account activity: the entries that name them (impersonations of their account).
CREATE POLICY target_read ON admin_audit_log FOR SELECT
  USING (target_user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE FUNCTION admin_audit_log_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only' USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
CREATE TRIGGER admin_audit_log_append_only BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_append_only();
--> statement-breakpoint
CREATE TRIGGER admin_audit_log_no_truncate BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_log_append_only();
--> statement-breakpoint

-- `p_query` as an ILIKE pattern matching it anywhere, wildcards escaped.
CREATE FUNCTION admin_like(p_query text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  $$;
--> statement-breakpoint

-- Workspaces for the console, newest first: by name or id (`p_query`), or one (`p_id`).
CREATE FUNCTION admin_workspaces(p_query text, p_id uuid, p_limit integer, p_offset integer)
  RETURNS TABLE (id uuid, name text, plan text, plan_overrides jsonb, created_at timestamptz,
                 deleted_at timestamptz, suspended_at timestamptz, suspended_reason text,
                 members bigint, records bigint, last_active_at timestamptz, total bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM admin_assert();
  RETURN QUERY
    WITH matched AS (
      SELECT w.* FROM workspaces w
       WHERE (p_id IS NULL OR w.id = p_id)
         AND (coalesce(p_query, '') = '' OR w.name ILIKE admin_like(p_query)
              OR w.id::text = lower(p_query))
    )
    SELECT m.id, m.name, m.plan, m.plan_overrides, m.created_at, m.deleted_at, m.suspended_at,
           m.suspended_reason,
           (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = m.id),
           (SELECT coalesce(sum(c.records), 0)::bigint
              FROM table_record_counts c
              JOIN tables t ON t.id = c.table_id AND t.deleted_at IS NULL
              JOIN bases b ON b.id = t.base_id AND b.deleted_at IS NULL
             WHERE c.workspace_id = m.id),
           (SELECT max(s.last_seen_at)
              FROM sessions s
              JOIN workspace_members wm ON wm.user_id = s.user_id
             WHERE wm.workspace_id = m.id),
           count(*) OVER ()
      FROM matched m
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT least(p_limit, 100) OFFSET p_offset;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_workspaces(text, uuid, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_workspaces(text, uuid, integer, integer) TO openrows_app;
--> statement-breakpoint

-- Users for the console, newest first: by email, name or id (`p_query`), or one (`p_id`).
CREATE FUNCTION admin_users(p_query text, p_id uuid, p_limit integer, p_offset integer)
  RETURNS TABLE (id uuid, email text, name text, created_at timestamptz,
                 last_active_at timestamptz, workspaces bigint, is_system_admin boolean,
                 suspended_at timestamptz, suspended_reason text, deleted_at timestamptz,
                 total bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM admin_assert();
  RETURN QUERY
    WITH matched AS (
      SELECT u.* FROM users u
       WHERE (p_id IS NULL OR u.id = p_id)
         AND (coalesce(p_query, '') = '' OR u.email ILIKE admin_like(p_query)
              OR u.name ILIKE admin_like(p_query) OR u.id::text = lower(p_query))
    )
    SELECT m.id, m.email, m.name, m.created_at,
           (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = m.id),
           (SELECT count(*) FROM workspace_members wm WHERE wm.user_id = m.id),
           m.is_system_admin, m.suspended_at, m.suspended_reason, m.deleted_at,
           count(*) OVER ()
      FROM matched m
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT least(p_limit, 100) OFFSET p_offset;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_users(text, uuid, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_users(text, uuid, integer, integer) TO openrows_app;
--> statement-breakpoint

-- A user's workspace memberships (live workspaces).
CREATE FUNCTION admin_user_memberships(p_user uuid)
  RETURNS TABLE (workspace_id uuid, workspace_name text, role text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM admin_assert();
  RETURN QUERY
    SELECT w.id, w.name, wm.role
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
     WHERE wm.user_id = p_user
     ORDER BY w.name, w.id
     LIMIT 500;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_user_memberships(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_user_memberships(uuid) TO openrows_app;
--> statement-breakpoint

-- Personal access tokens of a user (`p_user`) or granted a workspace or one of its bases
-- (`p_workspace`), newest first. Never the secret's hash or the public id.
CREATE FUNCTION admin_tokens(p_user uuid, p_workspace uuid)
  RETURNS TABLE (id uuid, user_id uuid, user_email text, name text, scopes text[],
                 created_at timestamptz, expires_at timestamptz, last_used_at timestamptz,
                 revoked_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
#variable_conflict use_column
BEGIN
  PERFORM admin_assert();
  RETURN QUERY
    SELECT t.id, t.user_id, u.email, t.name, t.scopes, t.created_at, t.expires_at,
           t.last_used_at, t.revoked_at
      FROM personal_access_tokens t
      JOIN users u ON u.id = t.user_id
     WHERE (p_user IS NULL OR t.user_id = p_user)
       AND (p_workspace IS NULL OR p_workspace = ANY (t.workspace_ids)
            OR t.base_ids && ARRAY(SELECT b.id FROM bases b WHERE b.workspace_id = p_workspace))
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT 200;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_tokens(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_tokens(uuid, uuid) TO openrows_app;
--> statement-breakpoint

-- Revokes a user's token (already revoked: unchanged). False when the user has no such token.
CREATE FUNCTION admin_token_revoke(p_user uuid, p_token uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  PERFORM admin_assert();
  UPDATE personal_access_tokens SET revoked_at = coalesce(revoked_at, now())
   WHERE id = p_token AND user_id = p_user;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_token_revoke(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_token_revoke(uuid, uuid) TO openrows_app;
--> statement-breakpoint

-- Suspends a workspace (keeping the first suspension's time) or lifts it. False when there is
-- no such workspace. The app role can't UPDATE these columns itself (0069).
CREATE FUNCTION workspace_suspend_set(p_workspace uuid, p_suspended boolean, p_reason text)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  PERFORM admin_assert();
  UPDATE workspaces
     SET suspended_at = CASE WHEN p_suspended THEN coalesce(suspended_at, now()) END,
         suspended_reason = CASE WHEN p_suspended THEN p_reason END,
         updated_at = now()
   WHERE id = p_workspace;
  RETURN FOUND;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspace_suspend_set(uuid, boolean, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION workspace_suspend_set(uuid, boolean, text) TO openrows_app;
--> statement-breakpoint

-- authz_resolve also says whether the workspace is suspended: authorize() then allows only
-- actions a read-only member may do (403 WORKSPACE_SUSPENDED).
DROP FUNCTION authz_resolve(text, uuid, uuid);
--> statement-breakpoint
CREATE FUNCTION authz_resolve(p_kind text, p_id uuid, p_user_id uuid)
  RETURNS TABLE (workspace_id uuid, base_id uuid, workspace_role text, base_role text,
                 suspended boolean)
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
    SELECT target.workspace_id, target.base_id, wm.role, bm.role, w.suspended_at IS NOT NULL
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
--> statement-breakpoint

-- Share links and public forms of a suspended workspace stop resolving (no row, as for every
-- other reason).
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
           s.allow_download, s.embed_origins, s.allow_restricted_embed
      FROM shares s
      JOIN workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
                       AND w.suspended_at IS NULL
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
  $$;
