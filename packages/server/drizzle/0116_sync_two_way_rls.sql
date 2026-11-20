-- Two-way syncs. Hand-written, like 0095_table_syncs_rls.sql.
--
-- A two-way sync's last applied values are tenant rows of the synced table's workspace.
ALTER TABLE table_sync_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE table_sync_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON table_sync_records
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Whether a two-way sync between p_table_id (the synced table) and p_source_table_id would close
-- a loop: the two are the same table, or already joined by a chain of two-way syncs (in either
-- direction, in any workspace), leaving out the sync p_sync_id itself. Two-way syncs among
-- tables must stay a forest, so no edit can travel back to where it came from. Answers a boolean
-- only: nothing about other tenants' syncs is returned.
CREATE FUNCTION table_sync_two_way_loop(p_table_id uuid, p_source_table_id uuid, p_sync_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH RECURSIVE edges(a, b) AS (
    SELECT s.table_id, s.source_table_id FROM table_syncs s
     WHERE s.two_way AND s.source_table_id IS NOT NULL
       AND s.id IS DISTINCT FROM p_sync_id
    UNION ALL
    SELECT s.source_table_id, s.table_id FROM table_syncs s
     WHERE s.two_way AND s.source_table_id IS NOT NULL
       AND s.id IS DISTINCT FROM p_sync_id
  ), reach(t) AS (
    SELECT p_source_table_id
    UNION
    SELECT e.b FROM edges e JOIN reach r ON e.a = r.t
  )
  SELECT p_table_id = p_source_table_id OR EXISTS (SELECT 1 FROM reach WHERE t = p_table_id)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION table_sync_two_way_loop(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION table_sync_two_way_loop(uuid, uuid, uuid) TO openrows_app;
