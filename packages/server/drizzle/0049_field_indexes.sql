-- Field indexes for saved views' sorts, groups and filters (#72, ADR-001). Hand-written: an
-- extension and SECURITY DEFINER functions of the DDL manager, with the rules of
-- 0005_ddl_manager.sql (only tables of the transaction's workspace, names from metadata or
-- checked against fixed patterns, everything quoted with format('%I')).
--
-- CREATE INDEX CONCURRENTLY can't run inside a function or a transaction, and only a table's
-- owner may create an index on it. So these functions don't build indexes: under the tenant's
-- scope they check a requested index and answer the one statement that builds (or drops) it,
-- which the worker then runs on its own connection as the schema owner (src/indexes/sync.ts).
-- Every managed index is named i_<24 hex> (a hash of its definition), so only those are ever
-- listed or dropped; primary keys and junction indexes are never touched.

-- Trigram indexes for "contains" filters on text (ILIKE). pg_trgm is a trusted extension.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- The statement that builds one managed index on a table of the current workspace.
-- p_method: 'btree' or 'trgm'. p_keys: 1 to 8 objects { column, fn, desc }:
--   column: a field column (f_<32 hex>) or a system column (id, created_at, updated_at), which
--           must exist on the table;
--   fn: 'none', 'lower' (text columns) or 'coalesce_false' (boolean columns): the expressions
--       the query compiler sorts and filters by (src/data/query/compile.ts);
--   desc: btree only, DESC NULLS LAST instead of ASC NULLS FIRST (the compiler's orders); the
--         id, never NULL, is always plain ascending, as the compiler orders it.
-- A trigram index has exactly one key, a text column with fn 'none'.
CREATE FUNCTION ddl_index_statement(p_table_id uuid, p_name text, p_method text, p_keys jsonb)
  RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  loc record;
  k jsonb;
  v_column text;
  v_fn text;
  v_type regtype;
  v_expr text;
  v_parts text[] := '{}';
  v_trgm_schema text;
BEGIN
  SELECT * INTO loc FROM ddl_table_location(p_table_id);
  IF p_name IS NULL OR p_name !~ '^i_[0-9a-f]{24}$' THEN
    RAISE EXCEPTION 'ddl: invalid index name %', p_name;
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('btree', 'trgm') THEN
    RAISE EXCEPTION 'ddl: invalid index method %', p_method;
  END IF;
  IF jsonb_typeof(p_keys) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_keys) NOT BETWEEN 1 AND 8
     OR (p_method = 'trgm' AND jsonb_array_length(p_keys) <> 1) THEN
    RAISE EXCEPTION 'ddl: invalid index keys';
  END IF;
  FOR k IN SELECT value FROM jsonb_array_elements(p_keys) LOOP
    v_column := k->>'column';
    v_fn := coalesce(k->>'fn', 'none');
    IF v_column IS NULL
       OR (v_column !~ '^f_[0-9a-f]{32}$' AND v_column NOT IN ('id', 'created_at', 'updated_at')) THEN
      RAISE EXCEPTION 'ddl: invalid index column %', v_column;
    END IF;
    SELECT a.atttypid::regtype INTO v_type
      FROM pg_attribute a
     WHERE a.attrelid = format('%I.%I', loc.db_schema, loc.db_table)::regclass
       AND a.attname = v_column AND a.attnum > 0 AND NOT a.attisdropped;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ddl: no column % on table %', v_column, p_table_id;
    END IF;
    IF v_fn = 'none' THEN
      v_expr := format('%I', v_column);
    ELSIF v_fn = 'lower' AND v_type = 'text'::regtype THEN
      v_expr := format('(lower(%I))', v_column);
    ELSIF v_fn = 'coalesce_false' AND v_type = 'boolean'::regtype THEN
      v_expr := format('(coalesce(%I, false))', v_column);
    ELSE
      RAISE EXCEPTION 'ddl: invalid index expression % on %', v_fn, v_column;
    END IF;
    IF p_method = 'trgm' THEN
      IF v_fn <> 'none' OR v_type <> 'text'::regtype THEN
        RAISE EXCEPTION 'ddl: a trigram index needs a text column';
      END IF;
      SELECT n.nspname INTO v_trgm_schema
        FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pg_trgm';
      v_parts := v_parts || format('%s %I.gin_trgm_ops', v_expr, v_trgm_schema);
    ELSIF v_column = 'id' THEN
      -- Never NULL: plain ascending, as the compiler orders it (and the primary key).
      v_parts := v_parts || v_expr;
    ELSIF (k->>'desc')::boolean IS TRUE THEN
      v_parts := v_parts || (v_expr || ' DESC NULLS LAST');
    ELSE
      v_parts := v_parts || (v_expr || ' ASC NULLS FIRST');
    END IF;
  END LOOP;
  RETURN format('CREATE INDEX CONCURRENTLY IF NOT EXISTS %I ON %I.%I USING %s (%s)',
    p_name, loc.db_schema, loc.db_table,
    CASE p_method WHEN 'trgm' THEN 'gin' ELSE 'btree' END,
    array_to_string(v_parts, ', '));
END $$;
--> statement-breakpoint

-- The managed indexes (i_<24 hex>) of a table of the current workspace, and whether each is
-- valid (a failed or cancelled concurrent build leaves an invalid one behind).
CREATE FUNCTION ddl_index_list(p_table_id uuid)
  RETURNS TABLE (name text, valid boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  loc record;
BEGIN
  SELECT * INTO loc FROM ddl_table_location(p_table_id);
  RETURN QUERY
    SELECT c.relname::text, i.indisvalid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = format('%I.%I', loc.db_schema, loc.db_table)::regclass
       AND c.relname ~ '^i_[0-9a-f]{24}$'
     ORDER BY c.relname;
END $$;
--> statement-breakpoint

-- The statement that drops one managed index of a table of the current workspace. Refuses an
-- index of that name on another table.
CREATE FUNCTION ddl_index_drop_statement(p_table_id uuid, p_name text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  loc record;
BEGIN
  SELECT * INTO loc FROM ddl_table_location(p_table_id);
  IF p_name IS NULL OR p_name !~ '^i_[0-9a-f]{24}$' THEN
    RAISE EXCEPTION 'ddl: invalid index name %', p_name;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = loc.db_schema AND c.relname = p_name
       AND i.indrelid <> format('%I.%I', loc.db_schema, loc.db_table)::regclass) THEN
    RAISE EXCEPTION 'ddl: index % belongs to another table', p_name;
  END IF;
  RETURN format('DROP INDEX CONCURRENTLY IF EXISTS %I.%I', loc.db_schema, p_name);
END $$;
--> statement-breakpoint

-- The tables the index job looks at, every workspace (it then works in each one's tenant
-- scope): live tables of live bases with a live view that filters, sorts or groups, or with
-- managed indexes left to clean up. Ids only, in table id order after `p_after` (pages).
CREATE FUNCTION field_index_tables(p_after uuid, p_limit integer)
  RETURNS TABLE (workspace_id uuid, table_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT t.workspace_id, t.id
    FROM tables t
    JOIN bases b ON b.id = t.base_id AND b.deleted_at IS NULL
   WHERE t.deleted_at IS NULL
     AND (p_after IS NULL OR t.id > p_after)
     AND (EXISTS (SELECT 1 FROM views v
                   WHERE v.table_id = t.id AND v.deleted_at IS NULL
                     AND (coalesce(v.config->'sorts', '[]') NOT IN ('[]', 'null')
                       OR coalesce(v.config->'groupBy', '[]') NOT IN ('[]', 'null')
                       OR coalesce(v.config->'filter'->'conditions', '[]') NOT IN ('[]', 'null')))
       OR EXISTS (SELECT 1 FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    JOIN pg_index i ON i.indexrelid = c.oid
                    JOIN pg_class r ON r.oid = i.indrelid
                   WHERE n.nspname = t.db_schema AND r.relname = t.db_table
                     AND c.relname ~ '^i_[0-9a-f]{24}$'))
   ORDER BY t.id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION ddl_index_statement(uuid, text, text, jsonb) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ddl_index_list(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ddl_index_drop_statement(uuid, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION field_index_tables(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_index_statement(uuid, text, text, jsonb) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_index_list(uuid) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ddl_index_drop_statement(uuid, text) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION field_index_tables(uuid, integer) TO openrows_app;
