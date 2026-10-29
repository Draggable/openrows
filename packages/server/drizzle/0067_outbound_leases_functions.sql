-- Outbound concurrency slots (#124). Hand-written, like 0042_api_rate_limits_rls.sql.
--
-- A webhook delivery or automation run takes one of its workspace's `p_cap` slots before its
-- outbound work and gives it back after. pg-boss's group concurrency keeps most of a workspace's
-- excess jobs from being fetched at all, but it counts active jobs from a snapshot, so parallel
-- fetchers can overshoot; the slots are exact. A slot is a row per (key, slot): taking one is an
-- INSERT that only wins on a free or expired row (ON CONFLICT serializes the race). A crashed
-- worker's slot expires after `p_seconds`. Losing the UNLOGGED table in a crash frees every slot.
ALTER TABLE outbound_leases SET UNLOGGED;
--> statement-breakpoint
REVOKE ALL ON outbound_leases FROM openrows_app;
--> statement-breakpoint
CREATE FUNCTION outbound_lease_take(p_key text, p_cap int, p_holder text, p_seconds int)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_until timestamptz := clock_timestamp() + make_interval(secs => greatest(p_seconds, 1));
  i int;
BEGIN
  -- The same holder again (a retried handler): it keeps its slot.
  UPDATE outbound_leases SET expires_at = v_until WHERE key = p_key AND holder = p_holder;
  IF FOUND THEN
    RETURN true;
  END IF;
  FOR i IN 0 .. least(greatest(p_cap, 1), 64) - 1 LOOP
    INSERT INTO outbound_leases AS l (key, slot, holder, expires_at)
      VALUES (p_key, i, p_holder, v_until)
      ON CONFLICT (key, slot) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
      WHERE l.expires_at < clock_timestamp();
    IF FOUND THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbound_lease_take(text, int, text, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbound_lease_take(text, int, text, int) TO openrows_app;
--> statement-breakpoint
CREATE FUNCTION outbound_lease_release(p_key text, p_holder text) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DELETE FROM outbound_leases WHERE key = p_key AND holder = p_holder
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbound_lease_release(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbound_lease_release(text, text) TO openrows_app;
--> statement-breakpoint
-- Expired slots (crashed workers) past an hour; the worker's hourly ratelimit.prune.
CREATE FUNCTION outbound_lease_prune() RETURNS int
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH gone AS (
    DELETE FROM outbound_leases WHERE expires_at < now() - interval '1 hour' RETURNING 1
  )
  SELECT count(*)::int FROM gone
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbound_lease_prune() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbound_lease_prune() TO openrows_app;
