CREATE TABLE "airtable_import_records" (
	"job_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"airtable_id" text NOT NULL,
	"table_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"links" jsonb,
	CONSTRAINT "airtable_import_records_job_id_airtable_id_pk" PRIMARY KEY("job_id","airtable_id")
);
--> statement-breakpoint
ALTER TABLE "airtable_import_records" ADD CONSTRAINT "airtable_import_records_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airtable_import_records" ADD CONSTRAINT "airtable_import_records_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "airtable_import_records_table_idx" ON "airtable_import_records" USING btree ("job_id","table_id","airtable_id");--> statement-breakpoint
CREATE INDEX "airtable_import_records_workspace_id_idx" ON "airtable_import_records" USING btree ("workspace_id");