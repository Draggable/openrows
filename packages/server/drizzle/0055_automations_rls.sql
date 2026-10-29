-- Automations (#109): row-level security for the automation tables and the worker's
-- cross-tenant functions (the relay's matching, the scheduler, the run prune). Hand-written, like
-- 0046_webhooks_rls.sql.
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE automations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON automations
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON automation_runs
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE automation_matches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE automation_matches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON automation_matches
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE automation_run_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE automation_run_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON automation_run_counts
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- The enabled record-triggered automations of these bases, for the outbox relay (it runs outside
-- any tenant scope): metadata only, never the trigger's filter or the actions. Events from before
-- `armed_at` (when it was turned on or its trigger changed) aren't theirs.
CREATE FUNCTION automations_matching(p_base_ids uuid[])
  RETURNS TABLE (
    id uuid, workspace_id uuid, base_id uuid, trigger_type text, table_id uuid,
    armed_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT a.id, a.workspace_id, a.base_id, a.trigger_type, a.table_id, a.armed_at
    FROM automations a
    JOIN bases b ON b.workspace_id = a.workspace_id AND b.id = a.base_id
   WHERE a.enabled AND a.trigger_type <> 'scheduled' AND b.deleted_at IS NULL
     AND a.base_id = ANY(p_base_ids)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION automations_matching(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION automations_matching(uuid[]) TO openrows_app;
--> statement-breakpoint

-- Scheduled automations whose next run is due, oldest first, for the scheduler job (which then
-- works in each one's tenant scope): ids and times only.
CREATE FUNCTION automations_due(p_limit integer)
  RETURNS TABLE (id uuid, workspace_id uuid, next_run_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT a.id, a.workspace_id, a.next_run_at
    FROM automations a
    JOIN bases b ON b.workspace_id = a.workspace_id AND b.id = a.base_id
   WHERE a.enabled AND a.next_run_at IS NOT NULL AND a.next_run_at <= now()
     AND b.deleted_at IS NULL
   ORDER BY a.next_run_at
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION automations_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION automations_due(integer) TO openrows_app;
--> statement-breakpoint

-- Deletes runs older than `p_days` (the history keeps 30 days) and returns how many went. Every
-- workspace's, so it runs as the schema owner.
CREATE FUNCTION automation_runs_prune(p_days integer)
  RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH gone AS (
    DELETE FROM automation_runs
     WHERE created_at < now() - make_interval(days => greatest(p_days, 1))
    RETURNING 1)
  SELECT count(*) FROM gone
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION automation_runs_prune(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION automation_runs_prune(integer) TO openrows_app;
