-- Realtime (ADR-003, #87): outbox retention. Hand-written: drizzle-kit can't express functions.
-- The outbox is read per base by (base_id, id) (index outbox_base_id_id_idx, 0004). Both
-- functions run as the schema owner (SECURITY DEFINER) because retention is global: the server
-- connects as openrows_app, which only ever sees one workspace's rows (RLS, 0005).

-- Deletes events older than `keep`, as a prefix of ids: rows go in id order and stop at the
-- first newer one, so every id at or below the floor is gone and nothing above it is. Batches
-- of 10,000 keep each statement short. Returns how many rows went.
CREATE FUNCTION outbox_prune(keep interval) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  cutoff timestamptz := now() - keep;
  total bigint := 0;
  n bigint;
BEGIN
  LOOP
    WITH head AS (
      SELECT id, created_at FROM outbox ORDER BY id LIMIT 10000
    ), stop AS (
      SELECT min(id) AS id FROM head WHERE created_at >= cutoff
    )
    DELETE FROM outbox
    WHERE id IN (SELECT h.id FROM head h, stop s WHERE s.id IS NULL OR h.id < s.id);
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    EXIT WHEN n < 10000;
  END LOOP;
  RETURN total;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_prune(interval) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbox_prune(interval) TO openrows_app;
--> statement-breakpoint

-- The highest id that may have been pruned: events after it are all still there. Catch-up
-- answers 410 for a `since` below it. With an empty outbox, every id handed out so far is gone
-- (pruned or rolled back). Reveals one global number, no tenant data.
CREATE FUNCTION outbox_floor() RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT coalesce(
    (SELECT min(id) - 1 FROM outbox),
    (SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM outbox_id_seq)
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_floor() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbox_floor() TO openrows_app;
