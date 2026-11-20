-- Two-way sync with an OpenRows table or view: the opt-in, the fields written back, the run counts
-- and each record's last applied values.
CREATE TABLE "table_sync_records" (
	"workspace_id" uuid NOT NULL,
	"sync_id" uuid NOT NULL,
	"key_digest" text NOT NULL,
	"cells" jsonb NOT NULL,
	CONSTRAINT "table_sync_records_pk" PRIMARY KEY("sync_id","key_digest")
);
--> statement-breakpoint
ALTER TABLE "table_sync_runs" ADD COLUMN "written_back" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "table_sync_runs" ADD COLUMN "removed_from_source" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "table_syncs" ADD COLUMN "two_way" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "table_syncs" ADD COLUMN "write_back_field_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "table_sync_records" ADD CONSTRAINT "table_sync_records_sync_fk" FOREIGN KEY ("workspace_id","sync_id") REFERENCES "public"."table_syncs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;