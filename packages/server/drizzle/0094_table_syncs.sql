CREATE TABLE "table_sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sync_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"deleted" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"source_workspace_id" uuid NOT NULL,
	"source_base_id" uuid NOT NULL,
	"source_table_id" uuid NOT NULL,
	"source_view_id" uuid,
	"source_label" text DEFAULT '' NOT NULL,
	"key_field_id" uuid,
	"field_map" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_field_id" uuid NOT NULL,
	"schedule" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pause_reason" text,
	"created_by" uuid,
	"last_synced_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_syncs_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "synced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "synced" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "table_sync_runs" ADD CONSTRAINT "table_sync_runs_sync_fk" FOREIGN KEY ("workspace_id","sync_id") REFERENCES "public"."table_syncs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_syncs" ADD CONSTRAINT "table_syncs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_syncs" ADD CONSTRAINT "table_syncs_table_fk" FOREIGN KEY ("workspace_id","table_id") REFERENCES "public"."tables"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "table_sync_runs_sync_id_idx" ON "table_sync_runs" USING btree ("sync_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "table_syncs_table_id_unique" ON "table_syncs" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "table_syncs_base_id_idx" ON "table_syncs" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "table_syncs_next_run_at_idx" ON "table_syncs" USING btree ("next_run_at");