-- The account data export (#77): the comments a user wrote, in every workspace, including those
-- they have since left (their own words are their personal data). record_comments is a tenant
-- table under RLS, so this runs as the schema owner (SECURITY DEFINER) and answers only the
-- rows whose author is `p_user`, a keyset page at a time; the server passes the session's user.
CREATE FUNCTION account_comments(p_user uuid, p_after uuid, p_limit integer)
  RETURNS TABLE (
    id uuid, workspace_id uuid, base_id uuid, table_id uuid, record_id uuid, body text,
    created_at timestamptz, edited_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT c.id, c.workspace_id, c.base_id, c.table_id, c.record_id, c.body, c.created_at,
         c.edited_at
    FROM record_comments c
   WHERE c.author_id = p_user AND c.deleted_at IS NULL
     AND (p_after IS NULL OR c.id > p_after)
   ORDER BY c.id
   LIMIT least(greatest(p_limit, 0), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION account_comments(uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION account_comments(uuid, uuid, integer) TO openrows_app;
