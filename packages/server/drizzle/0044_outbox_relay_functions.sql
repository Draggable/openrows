-- The outbox relay (#105, ADR-004). Hand-written, like 0042_api_rate_limits_rls.sql.
--
-- The relay reads the outbox across workspaces, which RLS doesn't let openrows_app do, so it
-- goes through two SECURITY DEFINER functions and has no rights on the cursor table itself.
-- outbox_relay_next returns event metadata only (never the payload): a job handler reads the
-- payload under its tenant's scope.
--
-- Ordering: ids are handed out before commit, so a transaction holding id 10 can commit after
-- one holding id 11. The relay therefore orders by (txid, id) and only reads rows whose
-- transaction is older than every transaction still running (pg_snapshot_xmin). Anything that
-- commits later has a txid at or above that horizon, so it sorts after the cursor: nothing is
-- skipped. Rows from before this migration (txid null) are never relayed.
INSERT INTO outbox_relay_cursor (id, txid, outbox_id) VALUES (1, '0'::xid8, 0);
--> statement-breakpoint
REVOKE ALL ON outbox_relay_cursor FROM openrows_app;
--> statement-breakpoint
CREATE FUNCTION outbox_relay_next(p_limit int)
  RETURNS TABLE (
    id bigint,
    txid xid8,
    workspace_id uuid,
    base_id uuid,
    table_id uuid,
    kind text,
    actor_id uuid,
    created_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT o.id, o.txid, o.workspace_id, o.base_id, o.table_id, o.kind, o.actor_id, o.created_at
    FROM outbox o, outbox_relay_cursor c
   WHERE c.id = 1
     AND o.txid IS NOT NULL
     AND (o.txid, o.id) > (c.txid, c.outbox_id)
     AND o.txid < pg_snapshot_xmin(pg_current_snapshot())
   ORDER BY o.txid, o.id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_relay_next(int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbox_relay_next(int) TO openrows_app;
--> statement-breakpoint
-- Moves the cursor forward only: a stale or replayed call is a no-op.
CREATE FUNCTION outbox_relay_advance(p_txid xid8, p_id bigint) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH moved AS (
    UPDATE outbox_relay_cursor
       SET txid = p_txid, outbox_id = p_id, updated_at = now()
     WHERE id = 1 AND (txid, outbox_id) < (p_txid, p_id)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM moved)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_relay_advance(xid8, bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbox_relay_advance(xid8, bigint) TO openrows_app;
--> statement-breakpoint
-- The cursor's position and age, for the worker's metrics. Reveals no tenant data.
CREATE FUNCTION outbox_relay_lag() RETURNS TABLE (pending bigint, cursor_age_seconds float8)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT (SELECT count(*) FROM outbox o
           WHERE o.txid IS NOT NULL AND (o.txid, o.id) > (c.txid, c.outbox_id)),
         extract(epoch FROM now() - c.updated_at)::float8
    FROM outbox_relay_cursor c
   WHERE c.id = 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_relay_lag() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION outbox_relay_lag() TO openrows_app;
