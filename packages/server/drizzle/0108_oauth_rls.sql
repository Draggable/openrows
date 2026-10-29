-- Row-level security and the lookups of OAuth apps (#125). Hand-written, like
-- 0040_personal_access_tokens_rls.sql.
--
-- Apps belong to the user who registered them; authorizations, codes and tokens to the person
-- who consented. Each is read and written only in that user's scope (app.user_id). The consent
-- screen and the token endpoint run before that person is known (a client id, a code or a
-- token is all they have), so they find the row through the SECURITY DEFINER lookups below,
-- which return what the server then checks itself (secrets' hashes in constant time, expiry,
-- single use); every write after that is in the person's own scope.
ALTER TABLE oauth_apps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_apps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner ON oauth_apps
  USING (owner_id = (SELECT app_user_id()))
  WITH CHECK (owner_id = (SELECT app_user_id()));
--> statement-breakpoint
ALTER TABLE oauth_authorizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_authorizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner ON oauth_authorizations
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint
ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_codes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner ON oauth_codes
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner ON oauth_tokens
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint

-- An app by its public client id (live ones only): the consent screen's name and redirect URIs,
-- the token endpoint's secret hash.
CREATE FUNCTION oauth_app_lookup(p_client_id text)
  RETURNS TABLE (
    id uuid, owner_id uuid, name text, description text, homepage_url text, secret_hash text,
    redirect_uris text[]
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT a.id, a.owner_id, a.name, a.description, a.homepage_url, a.secret_hash, a.redirect_uris
    FROM oauth_apps a
   WHERE a.client_id = p_client_id AND a.deleted_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION oauth_app_lookup(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_app_lookup(text) TO openrows_app;
--> statement-breakpoint

-- An authorization code by its hash, with the app it was issued to.
CREATE FUNCTION oauth_code_lookup(p_code_hash text)
  RETURNS TABLE (
    id uuid, user_id uuid, authorization_id uuid, app_id uuid, redirect_uri text,
    code_challenge text, expires_at timestamptz, used_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT c.id, c.user_id, c.authorization_id, z.app_id, c.redirect_uri, c.code_challenge,
         c.expires_at, c.used_at
    FROM oauth_codes c
    JOIN oauth_authorizations z ON z.id = c.authorization_id
   WHERE c.code_hash = p_code_hash
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION oauth_code_lookup(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_code_lookup(text) TO openrows_app;
--> statement-breakpoint

-- An access or refresh token by its public id, with its authorization's scopes and grants and
-- whether the authorization or its app are gone.
CREATE FUNCTION oauth_token_lookup(p_public_id text)
  RETURNS TABLE (
    id uuid, kind text, user_id uuid, authorization_id uuid, secret_hash text,
    expires_at timestamptz, used_at timestamptz, created_at timestamptz, app_id uuid,
    app_name text, scopes text[], workspace_ids uuid[], base_ids uuid[], live boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT t.id, t.kind, t.user_id, t.authorization_id, t.secret_hash, t.expires_at, t.used_at,
         t.created_at, a.id, a.name, z.scopes, z.workspace_ids, z.base_ids,
         z.revoked_at IS NULL AND a.deleted_at IS NULL
    FROM oauth_tokens t
    JOIN oauth_authorizations z ON z.id = t.authorization_id
    JOIN oauth_apps a ON a.id = z.app_id
   WHERE t.public_id = p_public_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION oauth_token_lookup(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_token_lookup(text) TO openrows_app;
--> statement-breakpoint

-- The apps of the caller's live authorizations (Settings → Integrations): an app's name and
-- homepage, never its secret or redirect URIs. Apps are otherwise readable by their owner only.
CREATE FUNCTION oauth_authorized_apps()
  RETURNS TABLE (authorization_id uuid, app_id uuid, name text, homepage_url text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT z.id, a.id, a.name, a.homepage_url
    FROM oauth_authorizations z
    JOIN oauth_apps a ON a.id = z.app_id AND a.deleted_at IS NULL
   WHERE z.user_id = app_user_id() AND z.revoked_at IS NULL
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION oauth_authorized_apps() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_authorized_apps() TO openrows_app;
--> statement-breakpoint

-- Records an authorization's use, at most once a minute. Only called after a secret matched.
CREATE FUNCTION oauth_touch(p_authorization_id uuid)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  UPDATE oauth_authorizations SET last_used_at = now()
   WHERE id = p_authorization_id
     AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION oauth_touch(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_touch(uuid) TO openrows_app;
--> statement-breakpoint

-- The worker's prune: codes and tokens a day past their expiry, and everything under an
-- authorization revoked or an app deleted more than a day ago. Used refresh tokens stay until
-- they expire, so a replayed one is still recognised (and revokes its authorization).
CREATE FUNCTION oauth_prune()
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  n integer;
  m integer;
BEGIN
  DELETE FROM oauth_tokens WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day';
  GET DIAGNOSTICS m = ROW_COUNT;
  n := n + m;
  DELETE FROM oauth_tokens t USING oauth_authorizations z
   WHERE z.id = t.authorization_id AND z.revoked_at < now() - interval '1 day';
  GET DIAGNOSTICS m = ROW_COUNT;
  RETURN n + m;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION oauth_prune() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_prune() TO openrows_app;
