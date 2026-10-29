-- Plans and usage counters (#128): row-level security for the counters, the backfill of the
-- record counts, the plan columns closed to the app role, and the SECURITY DEFINER functions:
-- setting a plan (with a NOTIFY so every process drops its cached entitlements), counting an
-- API call, and listing the tables the worker reconciles. Hand-written, like 0055.

-- Today's live records of every table, before anything counts incrementally.
DO $$
DECLARE
  t record;
  n bigint;
BEGIN
  FOR t IN SELECT id, workspace_id, base_id, db_schema, db_table FROM tables LOOP
    IF to_regclass(format('%I.%I', t.db_schema, t.db_table)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE deleted_at IS NULL', t.db_schema, t.db_table)
      INTO n;
    INSERT INTO table_record_counts (workspace_id, base_id, table_id, records, reconciled_at)
    VALUES (t.workspace_id, t.base_id, t.id, n, now())
    ON CONFLICT (table_id) DO UPDATE SET records = excluded.records,
                                         reconciled_at = excluded.reconciled_at;
  END LOOP;
END
$$;
--> statement-breakpoint

ALTER TABLE table_record_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE table_record_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON table_record_counts
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE api_call_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE api_call_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON api_call_counts
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- The app role updates only the columns routes and jobs change; `plan` and `plan_overrides` go
-- through workspace_plan_set alone. A new workspaces column the app updates needs a grant here.
REVOKE UPDATE ON workspaces FROM openrows_app;
--> statement-breakpoint
GRANT UPDATE (name, db_cluster, snapshot_retention_days, updated_at, deleted_at)
  ON workspaces TO openrows_app;
--> statement-breakpoint

-- Sets a workspace's plan (null: the edition's default) and overrides, and tells every process
-- (the `workspace_plan` channel) to drop its cached entitlements. False when there is no such
-- workspace. For system operators' tools and, later, billing webhooks; never a tenant route.
CREATE FUNCTION workspace_plan_set(p_workspace uuid, p_plan text, p_overrides jsonb)
  RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF jsonb_typeof(p_overrides) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'plan overrides must be a JSON object';
  END IF;
  UPDATE workspaces SET plan = p_plan, plan_overrides = p_overrides, updated_at = now()
   WHERE id = p_workspace;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM pg_notify('workspace_plan', p_workspace::text);
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspace_plan_set(uuid, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION workspace_plan_set(uuid, text, jsonb) TO openrows_app;
--> statement-breakpoint

-- Counts `p_calls` REST API requests for the workspace in this UTC month. Called by the API's
-- admission (outside any tenant scope) once a request naming a base the caller reaches is let in.
CREATE FUNCTION api_call_count(p_workspace uuid, p_calls integer DEFAULT 1)
  RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  INSERT INTO api_call_counts AS c (workspace_id, month, calls)
  VALUES (p_workspace, date_trunc('month', now() AT TIME ZONE 'UTC')::date, greatest(p_calls, 0))
  ON CONFLICT (workspace_id, month) DO UPDATE SET calls = c.calls + excluded.calls
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION api_call_count(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION api_call_count(uuid, integer) TO openrows_app;
--> statement-breakpoint

-- Live tables of live bases of live workspaces after `p_after` (by id), for the worker's daily
-- reconcile, which then recounts each one in its tenant's scope. Ids only.
CREATE FUNCTION record_count_tables(p_after uuid, p_limit integer)
  RETURNS TABLE (workspace_id uuid, base_id uuid, table_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT t.workspace_id, t.base_id, t.id
    FROM tables t
    JOIN bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    JOIN workspaces w ON w.id = t.workspace_id AND w.deleted_at IS NULL
   WHERE t.deleted_at IS NULL AND (p_after IS NULL OR t.id > p_after)
   ORDER BY t.id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_count_tables(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_count_tables(uuid, integer) TO openrows_app;
