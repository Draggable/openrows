-- Background jobs (#108): row-level security for `jobs` and `storage_garbage`, the triggers that
-- collect the keys of deleted stored objects, and the worker's cross-tenant functions.
-- Hand-written, like 0046_webhooks_rls.sql.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON jobs
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
ALTER TABLE storage_garbage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE storage_garbage FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON storage_garbage
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Every deleted attachment row (a purge, a cascade from a purged field, table or base, or the GC
-- itself) leaves its file and thumbnail keys here; every deleted snapshot row its object's key.
-- SECURITY DEFINER: cascades from the snapshot prune run as the owner, outside any tenant scope.
CREATE FUNCTION storage_garbage_from_attachment() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  INSERT INTO storage_garbage (workspace_id, storage_key, kind)
  VALUES (OLD.workspace_id, OLD.storage_key,
          CASE WHEN OLD.status = 'pending' THEN 'pending' ELSE 'file' END);
  IF OLD.thumbnail_key IS NOT NULL THEN
    INSERT INTO storage_garbage (workspace_id, storage_key, kind)
    VALUES (OLD.workspace_id, OLD.thumbnail_key, 'file');
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION storage_garbage_from_attachment() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER attachments_storage_garbage AFTER DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION storage_garbage_from_attachment();
--> statement-breakpoint
CREATE FUNCTION storage_garbage_from_snapshot() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  INSERT INTO storage_garbage (workspace_id, storage_key, kind)
  VALUES (OLD.workspace_id, OLD.storage_key, 'snapshot');
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION storage_garbage_from_snapshot() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER base_snapshots_storage_garbage AFTER DELETE ON base_snapshots
  FOR EACH ROW EXECUTE FUNCTION storage_garbage_from_snapshot();
--> statement-breakpoint

-- The workspaces the attachment GC has to look at (it then works in each one's tenant scope):
-- those with stored-object garbage, or with attachment rows older than the grace period, in
-- workspace id order after `p_after` (pages).
CREATE FUNCTION storage_gc_workspaces(p_grace interval, p_after uuid, p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT w.workspace_id FROM (
    SELECT g.workspace_id FROM storage_garbage g
    UNION
    SELECT a.workspace_id FROM attachments a
     WHERE a.created_at < now() - p_grace) w
   WHERE p_after IS NULL OR w.workspace_id > p_after
   ORDER BY w.workspace_id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION storage_gc_workspaces(interval, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION storage_gc_workspaces(interval, uuid, integer) TO openrows_app;
--> statement-breakpoint

-- Finished background jobs past their retention, every workspace.
CREATE FUNCTION jobs_prune(p_days integer) RETURNS integer
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH gone AS (
    DELETE FROM jobs
     WHERE status <> 'running' AND finished_at < now() - make_interval(days => p_days)
    RETURNING 1)
  SELECT count(*)::integer FROM gone
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_prune(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION jobs_prune(integer) TO openrows_app;
--> statement-breakpoint

-- Running jobs whose pg-boss job has ended without finishing them (retries used up, or the worker
-- was killed on the last attempt) fail with a visible error, every workspace.
-- plpgsql: pg-boss's schema is installed after the Drizzle migrations (src/db/migrate.ts).
CREATE FUNCTION jobs_sweep() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  n integer;
BEGIN
  UPDATE jobs
     SET status = 'failed', payload = NULL, finished_at = now(),
         error = CASE kind WHEN 'import' THEN 'The import stopped because of a server error.'
                           ELSE 'The restore stopped because of a server error.' END
   WHERE status = 'running'
     AND created_at < now() - interval '1 minute'
     AND NOT EXISTS (SELECT 1 FROM pgboss.job j
                      WHERE j.id = jobs.id AND j.state IN ('created', 'retry', 'active'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_sweep() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION jobs_sweep() TO openrows_app;
