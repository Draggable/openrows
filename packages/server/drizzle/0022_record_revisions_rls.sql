-- Row-level security and retention for record revisions (#94). Hand-written, like 0003_rls.sql
-- and 0015_realtime_outbox.sql.
ALTER TABLE record_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE record_revisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON record_revisions
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Deletes revisions older than their workspace's retention: `overrides` maps a workspace id to
-- its days (hosted plans, #57), every other workspace keeps `default_days`. Retention is global,
-- so this runs as the schema owner (SECURITY DEFINER), like outbox_prune. Batches of 10,000 keep
-- each statement short. Returns how many rows went.
CREATE FUNCTION record_revisions_prune(default_days integer, overrides jsonb DEFAULT '{}'::jsonb)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  shortest integer;
  total bigint := 0;
  n bigint;
BEGIN
  IF default_days IS NULL OR default_days < 1 THEN
    RAISE EXCEPTION 'record_revisions_prune: default_days must be at least 1';
  END IF;
  SELECT least(default_days, coalesce(min(value::integer), default_days))
    INTO shortest FROM jsonb_each_text(coalesce(overrides, '{}'::jsonb));
  IF shortest < 1 THEN
    RAISE EXCEPTION 'record_revisions_prune: retention must be at least 1 day';
  END IF;
  LOOP
    DELETE FROM record_revisions
    WHERE id IN (
      SELECT r.id FROM record_revisions r
      WHERE r.created_at < now() - make_interval(days => shortest)
        AND r.updated_at < now() - make_interval(
          days => coalesce((overrides ->> r.workspace_id::text)::integer, default_days))
      LIMIT 10000
    );
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    EXIT WHEN n < 10000;
  END LOOP;
  RETURN total;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_revisions_prune(integer, jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_revisions_prune(integer, jsonb) TO openrows_app;
