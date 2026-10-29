-- Billing (#132): the worker's hourly `billing.dunning` sweep finds workspaces with a live
-- subscription (anything but ended) through this SECURITY DEFINER function, a page at a time,
-- then handles each in its own workspace-scoped transaction (RLS). Ids only.
CREATE FUNCTION billing_sweep_workspaces(p_after uuid, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT DISTINCT s.workspace_id
    FROM billing_subscriptions s
    JOIN workspaces w ON w.id = s.workspace_id AND w.deleted_at IS NULL
   WHERE s.status NOT IN ('canceled', 'incomplete_expired')
     AND (p_after IS NULL OR s.workspace_id > p_after)
   ORDER BY s.workspace_id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION billing_sweep_workspaces(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION billing_sweep_workspaces(uuid, integer) TO openrows_app;
