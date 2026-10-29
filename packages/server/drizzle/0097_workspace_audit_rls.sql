-- The workspace audit log (#157). Hand-written, like 0003_rls.sql.

-- Append-only: the app role inserts and reads its workspace's entries; nothing may change an
-- entry, and only workspace_audit_purge (retention, run by the worker) may remove one. The
-- trigger binds the table's owner too.
REVOKE UPDATE, DELETE, TRUNCATE ON workspace_audit_events FROM openrows_app;
--> statement-breakpoint
ALTER TABLE workspace_audit_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_audit_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON workspace_audit_events FOR SELECT
  USING (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY tenant_insert ON workspace_audit_events FOR INSERT
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE FUNCTION workspace_audit_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('openrows.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'workspace_audit_events is append-only' USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_audit_append_only BEFORE UPDATE OR DELETE ON workspace_audit_events
  FOR EACH ROW EXECUTE FUNCTION workspace_audit_append_only();
--> statement-breakpoint
CREATE TRIGGER workspace_audit_no_truncate BEFORE TRUNCATE ON workspace_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION workspace_audit_append_only();
--> statement-breakpoint

-- Retention: removes up to p_limit of the workspace's entries older than p_before, oldest first,
-- and returns how many. For a live workspace the cutoff must be at least a day old (a bug can't
-- empty a log); a purged workspace's entries all go.
CREATE FUNCTION workspace_audit_purge(p_workspace uuid, p_before timestamptz, p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM workspaces w WHERE w.id = p_workspace)
     AND p_before > now() - interval '1 day' THEN
    RAISE EXCEPTION 'audit retention cutoff must be at least a day old' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('openrows.audit_purge', 'on', true);
  DELETE FROM workspace_audit_events e
   WHERE e.id IN (SELECT x.id FROM workspace_audit_events x
                   WHERE x.workspace_id = p_workspace AND x.created_at < p_before
                   ORDER BY x.id
                   LIMIT greatest(p_limit, 0));
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('openrows.audit_purge', '', true);
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspace_audit_purge(uuid, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION workspace_audit_purge(uuid, timestamptz, integer) TO openrows_app;
--> statement-breakpoint

-- The workspaces with entries, after p_after in id order (a loose index scan), and whether each
-- still exists: for the retention job, which then works in each one's tenant scope. Ids only.
CREATE FUNCTION workspace_audit_workspaces(p_after uuid, p_limit integer)
  RETURNS TABLE (workspace_id uuid, live boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH RECURSIVE ids AS (
    (SELECT e.workspace_id FROM workspace_audit_events e
      WHERE e.workspace_id > coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid)
      ORDER BY e.workspace_id LIMIT 1)
    UNION ALL
    SELECT (SELECT e.workspace_id FROM workspace_audit_events e
             WHERE e.workspace_id > ids.workspace_id ORDER BY e.workspace_id LIMIT 1)
      FROM ids WHERE ids.workspace_id IS NOT NULL
  )
  SELECT ids.workspace_id, EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ids.workspace_id)
    FROM ids WHERE ids.workspace_id IS NOT NULL
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspace_audit_workspaces(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION workspace_audit_workspaces(uuid, integer) TO openrows_app;
--> statement-breakpoint

-- SIEM streams.
ALTER TABLE workspace_audit_streams ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_audit_streams FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON workspace_audit_streams
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Enabled streams with entries past their cursor, for the delivery job (which then works in each
-- one's tenant scope): ids only.
CREATE FUNCTION workspace_audit_streams_due(p_limit integer)
  RETURNS TABLE (workspace_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT s.workspace_id FROM workspace_audit_streams s
   WHERE s.enabled
     AND EXISTS (SELECT 1 FROM workspace_audit_events e
                  WHERE e.workspace_id = s.workspace_id
                    AND e.id > coalesce(s.cursor, '00000000-0000-0000-0000-000000000000'::uuid))
   ORDER BY s.last_delivery_at NULLS FIRST
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspace_audit_streams_due(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION workspace_audit_streams_due(integer) TO openrows_app;
