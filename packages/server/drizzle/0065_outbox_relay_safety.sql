-- Outbox safety (#124). Hand-written, like 0044_outbox_relay_functions.sql.
--
-- 1. The 7-day prune never deletes an event the relay hasn't read: it still walks the outbox's
--    head in id order (so outbox_floor stays true: every event after the floor is there), and
--    now stops at the first row that is recent OR past the relay cursor. Rows from before 0044
--    (txid null) are never relayed, so they go with age as before. A worker down for longer than
--    the retention keeps its backlog; the outbox grows until the relay catches up.
-- 2. outbox_relay_lag also answers the age of the oldest unrelayed event, for the worker's
--    metrics and the API's /ready details. Still no tenant data: three global numbers.
CREATE OR REPLACE FUNCTION outbox_prune(keep interval) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  cutoff timestamptz := now() - keep;
  c_txid xid8;
  c_id bigint;
  total bigint := 0;
  n bigint;
BEGIN
  SELECT c.txid, c.outbox_id INTO c_txid, c_id FROM outbox_relay_cursor c WHERE c.id = 1;
  LOOP
    WITH head AS (
      SELECT id, created_at, txid FROM outbox ORDER BY id LIMIT 10000
    ), stop AS (
      SELECT min(id) AS id FROM head
       WHERE created_at >= cutoff
          OR (txid IS NOT NULL AND (c_txid IS NULL OR (txid, id) > (c_txid, c_id)))
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
DROP FUNCTION outbox_relay_lag();
--> statement-breakpoint
CREATE FUNCTION outbox_relay_lag()
  RETURNS TABLE (pending bigint, cursor_age_seconds float8, oldest_pending_age_seconds float8)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT p.n,
         extract(epoch FROM now() - c.updated_at)::float8,
         coalesce(greatest(0, extract(epoch FROM now() - p.oldest)::float8), 0)
    FROM outbox_relay_cursor c,
         LATERAL (SELECT count(*) AS n, min(o.created_at) AS oldest FROM outbox o
                   WHERE o.txid IS NOT NULL AND (o.txid, o.id) > (c.txid, c.outbox_id)) p
   WHERE c.id = 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_relay_lag() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbox_relay_lag() TO openrows_app;
