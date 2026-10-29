-- The scheduled refresh of NOW()/TODAY() formulas (#86). Hand-written, like
-- 0037_snapshots_rls.sql.
--
-- The worker's `computed.volatile` job finds the bases to refresh across workspaces, which RLS
-- doesn't let openrows_app do, so it goes through this SECURITY DEFINER function. It returns ids
-- only; each base is then refreshed under its workspace's scope (withTenant). The regular
-- expression over the stored formula is a prefilter (a string literal "NOW(" matches too): the
-- job parses each formula and keeps only those that really call NOW() or TODAY().
CREATE FUNCTION volatile_formula_bases(p_after uuid, p_limit integer)
  RETURNS TABLE (workspace_id uuid, base_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT b.workspace_id, b.id
    FROM bases b
    JOIN workspaces w ON w.id = b.workspace_id AND w.deleted_at IS NULL
   WHERE b.deleted_at IS NULL
     AND (p_after IS NULL OR b.id > p_after)
     AND EXISTS (
       SELECT 1 FROM fields f JOIN tables t ON t.id = f.table_id
        WHERE t.base_id = b.id AND t.deleted_at IS NULL AND f.deleted_at IS NULL
          AND f.type IN ('formula', 'button')
          AND f.config->>'formula' ~* '\m(NOW|TODAY)\s*\(')
   ORDER BY b.id
   LIMIT least(greatest(p_limit, 1), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION volatile_formula_bases(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION volatile_formula_bases(uuid, integer) TO openrows_app;
