-- Row-level security and the worker's functions for webhooks (#107). Hand-written, like
-- 0037_snapshots_rls.sql.
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webhooks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON webhooks
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON webhook_deliveries
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- The enabled webhooks of these bases, for the outbox relay (it runs outside any tenant scope):
-- metadata only, never the URL or the secret. A webhook only ever matches its own base's events,
-- and only those from its creation on (`created_at`: the relay may run after it was made).
CREATE FUNCTION webhooks_matching(p_base_ids uuid[])
  RETURNS TABLE (
    id uuid, workspace_id uuid, base_id uuid, events text[], table_ids uuid[],
    created_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT w.id, w.workspace_id, w.base_id, w.events, w.table_ids, w.created_at
    FROM webhooks w
    JOIN bases b ON b.workspace_id = w.workspace_id AND b.id = w.base_id
   WHERE w.enabled AND b.deleted_at IS NULL AND w.base_id = ANY(p_base_ids)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION webhooks_matching(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION webhooks_matching(uuid[]) TO openrows_app;
--> statement-breakpoint

-- Deletes delivery attempts older than `p_days` (the delivery log keeps 7 days) and returns how
-- many went. Every workspace's, so it runs as the schema owner.
CREATE FUNCTION webhook_deliveries_prune(p_days integer)
  RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH gone AS (
    DELETE FROM webhook_deliveries
     WHERE created_at < now() - make_interval(days => greatest(p_days, 1))
    RETURNING 1)
  SELECT count(*) FROM gone
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION webhook_deliveries_prune(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION webhook_deliveries_prune(integer) TO openrows_app;
