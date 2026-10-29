-- Row-level security and the bearer lookup for personal access tokens (#102). Hand-written, like
-- 0003_rls.sql and 0024_notifications_rls.sql.
--
-- A token belongs to a user, not a workspace: only its owner lists, creates and revokes it, in
-- the user-only scope (app.user_id). Bearer auth runs before anyone is known, so it reads a
-- token by its public id through the SECURITY DEFINER pat_lookup; the server compares the
-- secret's hash in constant time and checks expiry and revocation itself.
ALTER TABLE personal_access_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE personal_access_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner ON personal_access_tokens
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE FUNCTION pat_lookup(p_public_id text)
  RETURNS TABLE (
    id uuid, user_id uuid, secret_hash text, scopes text[], workspace_ids uuid[],
    base_ids uuid[], expires_at timestamptz, revoked_at timestamptz, created_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT t.id, t.user_id, t.secret_hash, t.scopes, t.workspace_ids, t.base_ids, t.expires_at,
         t.revoked_at, t.created_at
    FROM personal_access_tokens t
   WHERE t.public_id = p_public_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pat_lookup(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pat_lookup(text) TO openrows_app;
--> statement-breakpoint
-- Records a use, at most once a minute per token. Only called after the secret matched.
CREATE FUNCTION pat_touch(p_id uuid)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  UPDATE personal_access_tokens SET last_used_at = now()
   WHERE id = p_id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pat_touch(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pat_touch(uuid) TO openrows_app;
