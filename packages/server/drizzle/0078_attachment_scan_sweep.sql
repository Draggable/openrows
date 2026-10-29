-- Malware scans (#133): the worker's `attachments.scan.sweep` finds uploads still `scanning` well
-- after their confirmation (a scan job that ran out of retries while the scanner was down, or
-- was lost) across workspaces through this SECURITY DEFINER function, and sends each one's scan
-- job again; the job itself reads and updates the row in its workspace's scope (RLS). Ids only.
CREATE FUNCTION attachments_scan_backlog(p_before timestamptz, p_limit integer)
  RETURNS TABLE (workspace_id uuid, attachment_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  SELECT a.workspace_id, a.id
    FROM attachments a
   WHERE a.status = 'scanning'
     AND a.confirmed_at < p_before
   ORDER BY a.confirmed_at
   LIMIT least(greatest(p_limit, 0), 1000)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION attachments_scan_backlog(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION attachments_scan_backlog(timestamptz, integer) TO openrows_app;
