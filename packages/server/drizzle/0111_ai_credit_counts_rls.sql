-- AI credits (#151): row-level security for the monthly counter, and the SECURITY DEFINER
-- function that counts an answered request on the instance's provider. The app role reads its
-- workspace's rows (the Usage page, the soft block) and writes them only through the function.
-- Hand-written, like 0069.

ALTER TABLE ai_credit_counts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ai_credit_counts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON ai_credit_counts
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON ai_credit_counts FROM openrows_app;
--> statement-breakpoint

-- Adds one answered request of `p_tokens` tokens costing `p_credits` credits to the workspace's
-- current UTC month; the month's total credits after it.
CREATE FUNCTION ai_credit_count(p_workspace uuid, p_credits integer, p_tokens integer)
  RETURNS bigint
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  INSERT INTO ai_credit_counts AS c (workspace_id, month, credits, requests, tokens)
  VALUES (p_workspace, date_trunc('month', now() AT TIME ZONE 'UTC')::date,
          greatest(p_credits, 0), 1, greatest(p_tokens, 0))
  ON CONFLICT (workspace_id, month) DO UPDATE
    SET credits = c.credits + excluded.credits,
        requests = c.requests + 1,
        tokens = c.tokens + excluded.tokens
  RETURNING credits
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ai_credit_count(uuid, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ai_credit_count(uuid, integer, integer) TO openrows_app;
