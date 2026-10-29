-- The outbox's tenant policy and the DDL manager's SECURITY DEFINER functions (ADR-001, #18).
-- Hand-written: drizzle-kit can't express policies, grants or functions.

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON outbox
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- The DDL manager (packages/server/src/data/ddl.ts). The server connects as openrows_app, which
-- has no DDL rights. These functions run as the schema owner (SECURITY DEFINER), so metadata
-- changes (as openrows_app, under RLS) and DDL happen in the same transaction. Each one:
--   * only touches a base or table whose metadata row belongs to the transaction's workspace
--     (app.workspace_id, set by withResource after authorize), so a caller can't reach another
--     tenant's objects even by passing its ids;
--   * takes names from metadata (b_<hex>, t_<hex>) or checks them against f_<32 hex>, and
--     quotes everything with format('%I'), so no input ends up as SQL;
--   * accepts column types from a fixed list (the registry's SqlColumnType).
-- Callers set lock_timeout first (SET LOCAL), so DDL never queues for long behind readers.

-- The physical location of a table of the current workspace. Raises when there is none.
CREATE FUNCTION ddl_table_location(p_table_id uuid, OUT db_schema text, OUT db_table text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  SELECT t.db_schema, t.db_table INTO db_schema, db_table
    FROM tables t
   WHERE t.id = p_table_id AND t.workspace_id = app_workspace_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ddl: table % not found in the current workspace', p_table_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF db_schema !~ '^b_[0-9a-f]{32}$' OR db_table !~ '^t_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'ddl: unexpected physical name %.%', db_schema, db_table;
  END IF;
END $$;
--> statement-breakpoint

-- Creates a base's record schema and lets openrows_app use it. Idempotent.
CREATE FUNCTION ddl_create_base_schema(p_base_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_schema text;
BEGIN
  SELECT b.db_schema INTO v_schema
    FROM bases b
   WHERE b.id = p_base_id AND b.workspace_id = app_workspace_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ddl: base % not found in the current workspace', p_base_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_schema !~ '^b_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'ddl: unexpected schema name %', v_schema;
  END IF;
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', v_schema);
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', v_schema);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO openrows_app', v_schema);
END $$;
--> statement-breakpoint

-- Creates a table's record table with the ADR-001 system columns (fields are added one by one
-- with ddl_add_column). openrows_app gets DML on it, never DDL.
CREATE FUNCTION ddl_create_table(p_table_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  loc record;
BEGIN
  SELECT * INTO loc FROM ddl_table_location(p_table_id);
  EXECUTE format(
    'CREATE TABLE %I.%I (
       id uuid PRIMARY KEY,
       version integer NOT NULL DEFAULT 1,
       created_at timestamptz NOT NULL DEFAULT now(),
       created_by uuid,
       updated_at timestamptz NOT NULL DEFAULT now(),
       updated_by uuid,
       deleted_at timestamptz
     )', loc.db_schema, loc.db_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO openrows_app',
    loc.db_schema, loc.db_table);
END $$;
--> statement-breakpoint

-- Adds a nullable column without a default (metadata-only, instant at any size), or a bigint
-- identity column for autonumbers (that one rewrites the table to number existing rows).
CREATE FUNCTION ddl_add_column(p_table_id uuid, p_column text, p_sql_type text, p_identity boolean)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  loc record;
BEGIN
  SELECT * INTO loc FROM ddl_table_location(p_table_id);
  IF p_column !~ '^f_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'ddl: invalid column name %', p_column;
  END IF;
  IF p_sql_type NOT IN ('text', 'text[]', 'numeric', 'smallint', 'bigint', 'boolean', 'date',
                        'timestamptz', 'uuid', 'jsonb') THEN
    RAISE EXCEPTION 'ddl: invalid column type %', p_sql_type;
  END IF;
  IF p_identity THEN
    IF p_sql_type <> 'bigint' THEN
      RAISE EXCEPTION 'ddl: identity columns are bigint';
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN %I bigint GENERATED ALWAYS AS IDENTITY',
      loc.db_schema, loc.db_table, p_column);
  ELSE
    -- p_sql_type is one of the literals above, never free text.
    EXECUTE format('ALTER TABLE %I.%I ADD COLUMN %I ' || p_sql_type,
      loc.db_schema, loc.db_table, p_column);
  END IF;
END $$;
--> statement-breakpoint

-- Drops a column that no field (live or in the trash) points at any more.
CREATE FUNCTION ddl_drop_column(p_table_id uuid, p_column text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  loc record;
BEGIN
  SELECT * INTO loc FROM ddl_table_location(p_table_id);
  IF p_column !~ '^f_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'ddl: invalid column name %', p_column;
  END IF;
  IF EXISTS (SELECT 1 FROM fields f WHERE f.table_id = p_table_id AND f.db_column = p_column) THEN
    RAISE EXCEPTION 'ddl: column % still belongs to a field', p_column;
  END IF;
  EXECUTE format('ALTER TABLE %I.%I DROP COLUMN IF EXISTS %I',
    loc.db_schema, loc.db_table, p_column);
END $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION ddl_table_location(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ddl_create_base_schema(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ddl_create_table(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ddl_add_column(uuid, text, text, boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ddl_drop_column(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_create_base_schema(uuid) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_create_table(uuid) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_add_column(uuid, text, text, boolean) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_drop_column(uuid, text) TO openrows_app;
