-- Airtable imports' record maps (#114): row-level security like `jobs` (0048). Hand-written.
ALTER TABLE airtable_import_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE airtable_import_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant ON airtable_import_records
  USING (workspace_id = (SELECT app_workspace_id()))
  WITH CHECK (workspace_id = (SELECT app_workspace_id()));
