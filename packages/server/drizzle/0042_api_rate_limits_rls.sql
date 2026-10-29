-- The API's rate limit buckets and per-token usage counters (#104). Hand-written, like
-- 0040_personal_access_tokens_rls.sql.
--
-- rate_limit_buckets holds one token bucket per base, token or user, shared by every server
-- instance. It is UNLOGGED (a crash only refills the buckets) and the app role has no rights on
-- it: requests go through rate_limit_take, which takes one token from every bucket a request
-- counts against, or from none.
ALTER TABLE rate_limit_buckets SET UNLOGGED;
--> statement-breakpoint
REVOKE ALL ON rate_limit_buckets FROM openrows_app;
--> statement-breakpoint
CREATE FUNCTION rate_limit_take(p_keys text[], p_capacities float8[], p_rates float8[])
  RETURNS TABLE (allowed boolean, remaining float8[])
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_n int := coalesce(array_length(p_keys, 1), 0);
  v_levels float8[] := '{}';
  v_level float8;
  v_tokens float8;
  v_at timestamptz;
  v_ok boolean := true;
  i int;
BEGIN
  IF v_n = 0 OR v_n > 8
     OR coalesce(array_length(p_capacities, 1), 0) <> v_n
     OR coalesce(array_length(p_rates, 1), 0) <> v_n THEN
    RAISE EXCEPTION 'rate_limit_take: one capacity and rate per key, 1 to 8 keys';
  END IF;
  -- New buckets start full. Rows are created and locked in key order, so concurrent requests
  -- never deadlock.
  INSERT INTO rate_limit_buckets (key, tokens, updated_at)
    SELECT u.k, u.c, v_now FROM unnest(p_keys, p_capacities) AS u(k, c) ORDER BY u.k
    ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM rate_limit_buckets WHERE key = ANY (p_keys) ORDER BY key FOR UPDATE;
  FOR i IN 1..v_n LOOP
    SELECT b.tokens, b.updated_at INTO v_tokens, v_at FROM rate_limit_buckets b WHERE b.key = p_keys[i];
    v_level := least(
      p_capacities[i],
      v_tokens + greatest(0, extract(epoch FROM v_now - v_at)) * p_rates[i]
    );
    v_levels := v_levels || v_level;
    IF v_level < 1 THEN
      v_ok := false;
    END IF;
  END LOOP;
  FOR i IN 1..v_n LOOP
    IF v_ok THEN
      v_levels[i] := v_levels[i] - 1;
    END IF;
    UPDATE rate_limit_buckets b
       SET tokens = v_levels[i], updated_at = greatest(b.updated_at, v_now)
     WHERE b.key = p_keys[i];
  END LOOP;
  allowed := v_ok;
  remaining := v_levels;
  RETURN NEXT;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rate_limit_take(text[], float8[], float8[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rate_limit_take(text[], float8[], float8[]) TO openrows_app;
--> statement-breakpoint
-- Buckets idle that long are full again: dropping them changes nothing. The worker's hourly job.
CREATE FUNCTION rate_limit_prune(p_idle_seconds int)
  RETURNS int
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH gone AS (
    DELETE FROM rate_limit_buckets
     WHERE updated_at < now() - make_interval(secs => p_idle_seconds)
    RETURNING 1
  )
  SELECT count(*)::int FROM gone
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rate_limit_prune(int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rate_limit_prune(int) TO openrows_app;
--> statement-breakpoint
-- Usage counters belong to the token's owner, like the token (0040).
ALTER TABLE personal_access_token_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE personal_access_token_usage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY owner ON personal_access_token_usage
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint
-- A bearer request whose secret matched: one more request today (UTC), and last_used_at at most
-- once a minute (pat_touch's rule). Bearer auth runs before any scope is set, hence DEFINER.
CREATE FUNCTION pat_use(p_id uuid)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  INSERT INTO personal_access_token_usage AS u (token_id, user_id, day, requests)
    SELECT t.id, t.user_id, (now() AT TIME ZONE 'UTC')::date, 1
      FROM personal_access_tokens t WHERE t.id = p_id
    ON CONFLICT (token_id, day) DO UPDATE SET requests = u.requests + 1;
  UPDATE personal_access_tokens SET last_used_at = now()
   WHERE id = p_id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pat_use(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pat_use(uuid) TO openrows_app;
--> statement-breakpoint
CREATE FUNCTION pat_usage_prune(p_days int)
  RETURNS int
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH gone AS (
    DELETE FROM personal_access_token_usage
     WHERE day < (now() AT TIME ZONE 'UTC')::date - p_days
    RETURNING 1
  )
  SELECT count(*)::int FROM gone
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION pat_usage_prune(int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION pat_usage_prune(int) TO openrows_app;
