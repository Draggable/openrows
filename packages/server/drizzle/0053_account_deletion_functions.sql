-- Account, workspace and trash deletion (#76): the functions behind "Delete account" and the
-- worker's purge jobs. They cross tenants (a user's memberships, other users' token grants), so
-- they are SECURITY DEFINER with a pinned search_path, and each one checks that what it deletes
-- was already marked deleted: the app can't purge a live user or workspace through them.
-- Hand-written, like 0048_background_jobs_rls.sql.

-- The live workspaces `p_user` owns, with how many other owners and other people (members and
-- base collaborators) each has: "Delete account" deletes those nobody else is in, leaves those
-- with another owner, and refuses while the user is the only owner of a shared one.
CREATE FUNCTION account_owned_workspaces(p_user uuid)
  RETURNS TABLE (workspace_id uuid, name text, other_owners integer, others integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT w.id, w.name,
         (SELECT count(*) FROM workspace_members o
           WHERE o.workspace_id = w.id AND o.user_id <> p_user AND o.role = 'owner')::integer,
         (SELECT count(*) FROM (
            SELECT o.user_id FROM workspace_members o
             WHERE o.workspace_id = w.id AND o.user_id <> p_user
            UNION
            SELECT b.user_id FROM base_members b
             WHERE b.workspace_id = w.id AND b.user_id <> p_user) people)::integer
    FROM workspace_members m
    JOIN workspaces w ON w.id = m.workspace_id
   WHERE m.user_id = p_user AND m.role = 'owner' AND w.deleted_at IS NULL
   ORDER BY w.name, w.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION account_owned_workspaces(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION account_owned_workspaces(uuid) TO openrows_app;
--> statement-breakpoint

-- "Delete account": marks the user deleted, ends every session, deletes their personal access
-- tokens, and deletes (marks, for the purge) the workspaces they own that nobody else is in.
-- Returns those workspaces. The caller has checked the sole-owner rule in the same transaction.
CREATE FUNCTION account_request_deletion(p_user uuid)
  RETURNS SETOF uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  UPDATE users SET deleted_at = coalesce(deleted_at, now()), updated_at = now()
   WHERE id = p_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account: no user %', p_user USING ERRCODE = 'no_data_found';
  END IF;
  DELETE FROM sessions WHERE user_id = p_user;
  DELETE FROM personal_access_tokens WHERE user_id = p_user;
  RETURN QUERY
    UPDATE workspaces w SET deleted_at = now(), updated_at = now()
     WHERE w.id IN (SELECT o.workspace_id FROM account_owned_workspaces(p_user) o
                     WHERE o.other_owners = 0 AND o.others = 0)
    RETURNING w.id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION account_request_deletion(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION account_request_deletion(uuid) TO openrows_app;
--> statement-breakpoint

-- What the purge job has to do: users and workspaces marked deleted, oldest first.
CREATE FUNCTION purge_pending(p_limit integer)
  RETURNS TABLE (kind text, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  (SELECT 'user', u.id FROM users u WHERE u.deleted_at IS NOT NULL
    ORDER BY u.deleted_at LIMIT greatest(p_limit, 0))
  UNION ALL
  (SELECT 'workspace', w.id FROM workspaces w WHERE w.deleted_at IS NOT NULL
    ORDER BY w.deleted_at LIMIT greatest(p_limit, 0))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_pending(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_pending(integer) TO openrows_app;
--> statement-breakpoint

-- Deletes a user marked deleted for good. Workspaces they were the only owner of get a new owner
-- (the member with the highest role, longest there), or, with nobody left, are marked deleted for
-- the workspace purge. Their mentions in other people's comments become plain "@Deleted user",
-- their personal views and the invitations sent to their address go, then the row, which takes
-- sessions, tokens, memberships, base roles, notifications and reactions with it (other
-- references to the user are set null by their foreign keys). Returns the user's issuer and
-- subject, for deleting them at the identity provider, or nothing if there was no such user.
CREATE FUNCTION account_purge(p_user uuid)
  RETURNS TABLE (oidc_issuer text, oidc_subject text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_user users%ROWTYPE;
  v_ws uuid;
  v_next uuid;
  v_token text := '@\[[^]]*\]\(user:' || p_user::text || '\)';
BEGIN
  SELECT * INTO v_user FROM users WHERE users.id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_user.deleted_at IS NULL THEN
    RAISE EXCEPTION 'account: user % is not marked deleted', p_user;
  END IF;
  FOR v_ws IN
    SELECT m.workspace_id FROM workspace_members m
     WHERE m.user_id = p_user AND m.role = 'owner'
       AND NOT EXISTS (SELECT 1 FROM workspace_members o
                        WHERE o.workspace_id = m.workspace_id AND o.user_id <> p_user
                          AND o.role = 'owner')
  LOOP
    SELECT o.user_id INTO v_next FROM workspace_members o
     WHERE o.workspace_id = v_ws AND o.user_id <> p_user
     ORDER BY array_position(ARRAY['creator', 'editor', 'commenter', 'read_only'], o.role),
              o.created_at, o.user_id
     LIMIT 1;
    IF FOUND THEN
      UPDATE workspace_members SET role = 'owner', updated_at = now()
       WHERE workspace_id = v_ws AND user_id = v_next;
    ELSE
      UPDATE workspaces SET deleted_at = coalesce(deleted_at, now()) WHERE workspaces.id = v_ws;
    END IF;
  END LOOP;
  UPDATE record_comments
     SET mentions = array_remove(mentions, p_user),
         body = regexp_replace(body, v_token, '@Deleted user', 'g')
   WHERE p_user = ANY(mentions) OR body ~ v_token;
  DELETE FROM views WHERE personal AND created_by = p_user;
  IF v_user.email IS NOT NULL THEN
    DELETE FROM workspace_invitations WHERE email = lower(v_user.email);
  END IF;
  DELETE FROM rate_limit_buckets WHERE key = 'user:' || p_user::text;
  DELETE FROM users WHERE users.id = p_user;
  RETURN QUERY SELECT v_user.oidc_issuer, v_user.oidc_subject;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION account_purge(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION account_purge(uuid) TO openrows_app;
--> statement-breakpoint

-- The last step of a workspace's purge, once the worker has dropped its bases' record schemas
-- (ddl_drop_base_schema) and deleted its stored files: other users' token grants and the API's
-- rate limit buckets stop naming it and its bases, then the row goes (every tenant table
-- cascades from it), then the stored-object garbage its cascade left (the files are gone).
CREATE FUNCTION workspace_purge(p_workspace uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_deleted timestamptz;
  v_bases uuid[];
BEGIN
  SELECT w.deleted_at INTO v_deleted FROM workspaces w WHERE w.id = p_workspace FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_deleted IS NULL THEN
    RAISE EXCEPTION 'purge: workspace % is not marked deleted', p_workspace;
  END IF;
  IF EXISTS (SELECT 1 FROM bases b JOIN pg_namespace n ON n.nspname = b.db_schema
              WHERE b.workspace_id = p_workspace) THEN
    RAISE EXCEPTION 'purge: workspace % still has record schemas', p_workspace;
  END IF;
  SELECT coalesce(array_agg(b.id), '{}') INTO v_bases FROM bases b
   WHERE b.workspace_id = p_workspace;
  UPDATE personal_access_tokens t
     SET workspace_ids = array_remove(t.workspace_ids, p_workspace),
         base_ids = ARRAY(SELECT x FROM unnest(t.base_ids) x WHERE x <> ALL (v_bases))
   WHERE p_workspace = ANY(t.workspace_ids) OR t.base_ids && v_bases;
  DELETE FROM rate_limit_buckets
   WHERE key IN (SELECT 'base:' || x::text FROM unnest(v_bases) x);
  DELETE FROM workspaces WHERE id = p_workspace;
  DELETE FROM storage_garbage WHERE workspace_id = p_workspace;
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspace_purge(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION workspace_purge(uuid) TO openrows_app;
--> statement-breakpoint

-- The live workspaces, in id order after `p_after` (pages): the daily trash purge looks at each
-- one's trash in its tenant scope.
CREATE FUNCTION purge_trash_workspaces(p_after uuid, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT w.id FROM workspaces w
   WHERE w.deleted_at IS NULL AND (p_after IS NULL OR w.id > p_after)
   ORDER BY w.id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_trash_workspaces(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_trash_workspaces(uuid, integer) TO openrows_app;
