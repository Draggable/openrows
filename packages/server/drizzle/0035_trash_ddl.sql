-- Permanent deletion from the trash (#95). Hand-written: SECURITY DEFINER functions of the DDL
-- manager (packages/server/src/data/ddl.ts), with the rules of 0005_ddl_manager.sql: they only
-- act on tables and bases of the transaction's workspace, take every physical name from metadata
-- and quote with format('%I'). Both refuse anything that isn't in the trash.

-- Drops a trashed table's record table. Its link junctions must be dropped first: without
-- CASCADE, a junction still referencing the table makes this fail rather than lose a link.
CREATE FUNCTION ddl_drop_table(p_table_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  loc record;
BEGIN
  SELECT * INTO loc FROM ddl_table_location(p_table_id);
  IF NOT EXISTS (SELECT 1 FROM tables t
                  WHERE t.id = p_table_id AND t.deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ddl: table % is not in the trash', p_table_id;
  END IF;
  EXECUTE format('DROP TABLE IF EXISTS %I.%I', loc.db_schema, loc.db_table);
END $$;
--> statement-breakpoint

-- Drops a trashed base's record schema with every record table and junction in it.
CREATE FUNCTION ddl_drop_base_schema(p_base_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_schema text;
BEGIN
  SELECT b.db_schema INTO v_schema
    FROM bases b
   WHERE b.id = p_base_id AND b.workspace_id = app_workspace_id() AND b.deleted_at IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ddl: base % is not in the trash of the current workspace', p_base_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_schema !~ '^b_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'ddl: unexpected schema name %', v_schema;
  END IF;
  EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', v_schema);
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION ddl_drop_table(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ddl_drop_base_schema(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_drop_table(uuid) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_drop_base_schema(uuid) TO openrows_app;
