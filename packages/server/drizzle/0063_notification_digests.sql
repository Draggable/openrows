-- Notification digests (#122). Hand-written, like 0024_notifications_rls.sql.
--
-- The immediate claim (src/notifications/mailer.ts, the worker's `notifications.email`) now
-- takes only notifications of users who want emails as they come
-- (`users.notification_frequency = 'immediately'`); everyone else's wait for their digest.
CREATE OR REPLACE FUNCTION notifications_email_claim(throttle_seconds integer, max_rows integer)
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
    JOIN users u ON u.id = p.user_id AND u.notification_frequency = 'immediately'
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
    FOR UPDATE OF p SKIP LOCKED
  )
    -- Re-checked on the locked row: a concurrent digest claim may have taken it.
    AND (n.email_state = 'pending'
         OR (n.email_state = 'sending' AND n.emailed_at < now() - interval '15 minutes'))
  RETURNING n.*;
END
$$;
--> statement-breakpoint

-- The digest claim (the worker's `notifications.digest.hourly`/`.daily` jobs): marks as `sending`
-- everything due (pending, or a claim older than 15 minutes: a crashed send) of up to
-- `max_users` recipients whose frequency is `frequency`, all of each one's, so a recipient gets
-- one digest. The advisory lock serializes digest claims and the state change makes a second
-- claim (another worker, a retry) find nothing: each notification is in one digest. Access,
-- preferences and content are checked by the caller, in the recipient's scope.
CREATE FUNCTION notifications_digest_claim(frequency text, max_users integer)
  RETURNS SETOF notifications
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF frequency IS NULL OR frequency NOT IN ('hourly', 'daily') OR max_users IS NULL
     OR max_users < 1 THEN
    RAISE EXCEPTION 'notifications_digest_claim: invalid arguments';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('notifications_digest_claim', 0));
  RETURN QUERY
  WITH due AS (
    SELECT p.id, p.user_id FROM notifications p
    JOIN users u ON u.id = p.user_id AND u.notification_frequency = frequency
    WHERE p.email_state = 'pending'
       OR (p.email_state = 'sending' AND p.emailed_at < now() - interval '15 minutes')
  ), who AS (
    SELECT DISTINCT d.user_id FROM due d ORDER BY d.user_id LIMIT max_users
  )
  UPDATE notifications n SET email_state = 'sending', emailed_at = now()
  WHERE n.id IN (SELECT d.id FROM due d WHERE d.user_id IN (SELECT w.user_id FROM who w))
    AND (n.email_state = 'pending'
         OR (n.email_state = 'sending' AND n.emailed_at < now() - interval '15 minutes'))
  RETURNING n.*;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION notifications_digest_claim(text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION notifications_digest_claim(text, integer) TO openrows_app;
