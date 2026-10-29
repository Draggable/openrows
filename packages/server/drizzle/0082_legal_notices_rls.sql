-- Service notices (#78): row-level security on the three global notice tables, and the SECURITY
-- DEFINER functions the `notices` command (src/notices/cli.ts, connected as openrows_app) writes
-- and reads them through. The app role can read notices and its own dismissals and deliveries;
-- it can't write a notice or a delivery directly. Hand-written, like 0072.

ALTER TABLE legal_notices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE legal_notices FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Notices are announcements to every account (a price notice only to owners, which the list
-- query checks): anyone signed in may read them.
CREATE POLICY read ON legal_notices FOR SELECT USING (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON legal_notices FROM openrows_app;
--> statement-breakpoint

ALTER TABLE legal_notice_dismissals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE legal_notice_dismissals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY self ON legal_notice_dismissals
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint

ALTER TABLE legal_notice_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE legal_notice_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY self_read ON legal_notice_deliveries FOR SELECT
  USING (user_id = (SELECT app_user_id()));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON legal_notice_deliveries FROM openrows_app;
--> statement-breakpoint

-- Publishes a notice (the command checked kind, audience, sizes, URL and the least notice).
CREATE FUNCTION legal_notice_create(
  p_id uuid, p_kind text, p_audience text, p_title text, p_summary text, p_url text,
  p_effective timestamptz
) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  INSERT INTO legal_notices (id, kind, audience, title, summary, url, effective_at)
  VALUES (p_id, p_kind, p_audience, p_title, p_summary, p_url, p_effective)
$$;
--> statement-breakpoint

-- Takes a notice down (its banner disappears; no more emails). False when there's no such
-- live notice.
CREATE FUNCTION legal_notice_withdraw(p_id uuid) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  WITH w AS (
    UPDATE legal_notices SET withdrawn_at = now()
     WHERE id = p_id AND withdrawn_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM w)
$$;
--> statement-breakpoint

-- The accounts a notice still has to be emailed to, after `p_after` (by id), a page at a time:
-- live accounts with a verified address, for `owners` only those owning a live workspace, not
-- yet in the delivery log.
CREATE FUNCTION legal_notice_recipients(p_notice uuid, p_after uuid, p_limit integer)
  RETURNS TABLE (user_id uuid, email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT u.id, u.email
    FROM legal_notices n
    JOIN users u ON u.email_verified AND u.deleted_at IS NULL
   WHERE n.id = p_notice AND n.withdrawn_at IS NULL
     AND (p_after IS NULL OR u.id > p_after)
     AND (n.audience = 'everyone' OR EXISTS (
           SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.user_id = u.id AND m.role = 'owner' AND w.deleted_at IS NULL))
     AND NOT EXISTS (SELECT 1 FROM legal_notice_deliveries d
                      WHERE d.notice_id = n.id AND d.user_id = u.id)
   ORDER BY u.id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint

-- Logs one sent email (once per account and notice).
CREATE FUNCTION legal_notice_delivered(p_notice uuid, p_user uuid, p_run uuid) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  INSERT INTO legal_notice_deliveries (notice_id, user_id, run_id)
  VALUES (p_notice, p_user, p_run)
  ON CONFLICT DO NOTHING
$$;
--> statement-breakpoint

-- A notice's runs: how many emails each sent, and when.
CREATE FUNCTION legal_notice_runs(p_notice uuid)
  RETURNS TABLE (run_id uuid, sent integer, first_sent_at timestamptz, last_sent_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT d.run_id, count(*)::integer, min(d.sent_at), max(d.sent_at)
    FROM legal_notice_deliveries d
   WHERE d.notice_id = p_notice
   GROUP BY d.run_id
   ORDER BY min(d.sent_at)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION legal_notice_create(uuid, text, text, text, text, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION legal_notice_withdraw(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION legal_notice_recipients(uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION legal_notice_delivered(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION legal_notice_runs(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION legal_notice_create(uuid, text, text, text, text, text, timestamptz) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION legal_notice_withdraw(uuid) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION legal_notice_recipients(uuid, uuid, integer) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION legal_notice_delivered(uuid, uuid, uuid) TO openrows_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION legal_notice_runs(uuid) TO openrows_app;
