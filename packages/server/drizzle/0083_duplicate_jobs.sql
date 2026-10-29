-- Base duplicates (#142): `jobs` rows of kind 'duplicate'. The sweep words a dead duplicate's
-- error for its kind. Hand-written, replaces the function of 0059_airtable_import.sql.
CREATE OR REPLACE FUNCTION jobs_sweep() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  n integer;
  m integer;
BEGIN
  UPDATE jobs
     SET status = 'failed', payload = NULL, finished_at = now(),
         error = CASE kind WHEN 'import' THEN 'The import stopped because of a server error.'
                           WHEN 'airtable' THEN 'The Airtable import stopped because of a server error.'
                           WHEN 'duplicate' THEN 'The duplicate stopped because of a server error.'
                           ELSE 'The restore stopped because of a server error.' END
   WHERE status = 'running'
     AND created_at < now() - interval '1 minute'
     AND NOT EXISTS (SELECT 1 FROM pgboss.job j
                      WHERE j.id = jobs.id AND j.state IN ('created', 'retry', 'active'));
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE jobs
     SET status = 'failed', payload = NULL, finished_at = now(),
         error = 'The Airtable import took more than 24 hours, so its token was deleted. Start it again.'
   WHERE kind = 'airtable' AND status = 'running' AND created_at < now() - interval '24 hours';
  GET DIAGNOSTICS m = ROW_COUNT;
  UPDATE jobs SET payload = NULL
   WHERE kind = 'airtable' AND payload IS NOT NULL AND created_at < now() - interval '24 hours';
  RETURN n + m;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_sweep() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION jobs_sweep() TO openrows_app;
