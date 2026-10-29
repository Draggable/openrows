-- Junction tables of link fields (ADR-001, #34). Hand-written: SECURITY DEFINER functions of the
-- DDL manager (packages/server/src/data/ddl.ts), with the same rules as 0005_ddl_manager.sql:
-- they only act on fields and tables of the transaction's workspace, take every physical name
-- from metadata (or check it against l_<32 hex>) and quote with format('%I').

-- Creates the junction of a link field: l_<field hex> in the base schema, with
-- (from_id, to_id) as the key, from_id the record of the field's table and to_id the record of
-- the linked table (its inverse field reads the same rows with the roles swapped). `position`
-- orders a record's links on the from side, `inverse_position` on the to side. Foreign keys
-- cascade when a record is purged; soft-deleted records keep their rows, so a restore brings
-- their links back. The linked table must be in the same base (same schema): links never cross
-- bases, let alone workspaces.
CREATE FUNCTION ddl_create_junction(p_field_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_table uuid;
  v_column text;
  v_linked uuid;
  src record;
  dst record;
BEGIN
  SELECT f.table_id, f.db_column, (f.config->>'linkedTableId')::uuid
    INTO v_table, v_column, v_linked
    FROM fields f
   WHERE f.id = p_field_id AND f.workspace_id = app_workspace_id() AND f.type = 'link';
  IF NOT FOUND OR v_linked IS NULL THEN
    RAISE EXCEPTION 'ddl: link field % not found in the current workspace', p_field_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_column <> 'l_' || replace(p_field_id::text, '-', '') THEN
    RAISE EXCEPTION 'ddl: unexpected junction name %', v_column;
  END IF;
  SELECT * INTO src FROM ddl_table_location(v_table);
  SELECT * INTO dst FROM ddl_table_location(v_linked);
  IF src.db_schema <> dst.db_schema THEN
    RAISE EXCEPTION 'ddl: links can''t cross bases';
  END IF;
  EXECUTE format(
    'CREATE TABLE %1$I.%2$I (
       from_id uuid NOT NULL REFERENCES %1$I.%3$I (id) ON DELETE CASCADE,
       to_id uuid NOT NULL REFERENCES %1$I.%4$I (id) ON DELETE CASCADE,
       position double precision NOT NULL DEFAULT 0,
       inverse_position double precision NOT NULL DEFAULT 0,
       PRIMARY KEY (from_id, to_id)
     )', src.db_schema, v_column, src.db_table, dst.db_table);
  EXECUTE format('CREATE INDEX %I ON %I.%I (to_id, from_id)',
    v_column || '_to', src.db_schema, v_column);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO openrows_app',
    src.db_schema, v_column);
END $$;
--> statement-breakpoint

-- Drops a junction (with its rows) that no live field uses any more, in the schema of the base
-- of p_table_id.
CREATE FUNCTION ddl_drop_junction(p_table_id uuid, p_junction text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  loc record;
BEGIN
  SELECT * INTO loc FROM ddl_table_location(p_table_id);
  IF p_junction !~ '^l_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'ddl: invalid junction name %', p_junction;
  END IF;
  IF EXISTS (SELECT 1 FROM fields f
              WHERE f.workspace_id = app_workspace_id() AND f.db_column = p_junction
                AND f.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'ddl: junction % still belongs to a field', p_junction;
  END IF;
  EXECUTE format('DROP TABLE IF EXISTS %I.%I', loc.db_schema, p_junction);
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION ddl_create_junction(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ddl_drop_junction(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_create_junction(uuid) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_drop_junction(uuid, text) TO openrows_app;
