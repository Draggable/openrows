-- Row-level security, the mailer's claim and retention for notifications (#93). Hand-written,
-- like 0003_rls.sql and 0022_record_revisions_rls.sql.
--
-- A notification is created in the transaction of the write that caused it (a comment, a user
-- cell), scoped to that workspace, for someone else: writers may insert into their workspace.
-- Only the recipient reads, marks or deletes it, across workspaces (the inbox).
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_insert ON notifications FOR INSERT
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY recipient_read ON notifications FOR SELECT
  USING (user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY recipient_update ON notifications FOR UPDATE
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint
CREATE POLICY recipient_delete ON notifications FOR DELETE
  USING (user_id = (SELECT app_user_id()));
--> statement-breakpoint

-- The mailer's claim (src/notifications/mailer.ts): marks up to `max_rows` notifications to email
-- as `sending` (emailed_at = now()) and returns them. Due are pending notifications (and claims
-- older than 15 minutes, a crashed send) of a recipient and record that got no email in the last
-- `throttle_seconds`, so each pair gets at most one email per window and everything pending for
-- it goes in that email. Global, so SECURITY DEFINER; the advisory lock serializes claims of
-- concurrent API processes. Access, preferences and the content are checked by the caller, in the
-- recipient's scope, before anything is sent.
CREATE FUNCTION notifications_email_claim(throttle_seconds integer, max_rows integer)
  RETURNS SETOF notifications
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF throttle_seconds IS NULL OR throttle_seconds < 0 OR max_rows IS NULL OR max_rows < 1 THEN
    RAISE EXCEPTION 'notifications_email_claim: invalid arguments';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('notifications_email_claim', 0));
  RETURN QUERY
  UPDATE notifications n SET email_state = 'sending', emailed_at = now()
  WHERE n.id IN (
    SELECT p.id FROM notifications p
    WHERE (p.email_state = 'pending'
           OR (p.email_state = 'sending' AND p.emailed_at < now() - interval '15 minutes'))
      AND NOT EXISTS (
        SELECT 1 FROM notifications s
        WHERE s.user_id = p.user_id AND s.record_id = p.record_id
          AND s.email_state IN ('sent', 'sending')
          AND s.id <> p.id
          AND s.emailed_at > now() - make_interval(secs => throttle_seconds)
      )
    ORDER BY p.created_at
    LIMIT max_rows
    FOR UPDATE SKIP LOCKED
  )
  RETURNING n.*;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION notifications_email_claim(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION notifications_email_claim(integer, integer) TO openrows_app;
--> statement-breakpoint

-- Deletes notifications older than `keep_days` (the worker, hourly). Batches of 10,000.
CREATE FUNCTION notifications_prune(keep_days integer)
  RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  total bigint := 0;
  n bigint;
BEGIN
  IF keep_days IS NULL OR keep_days < 1 THEN
    RAISE EXCEPTION 'notifications_prune: keep_days must be at least 1';
  END IF;
  LOOP
    DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications WHERE created_at < now() - make_interval(days => keep_days)
      LIMIT 10000
    );
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    EXIT WHEN n < 10000;
  END LOOP;
  RETURN total;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION notifications_prune(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION notifications_prune(integer) TO openrows_app;
