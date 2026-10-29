CREATE TABLE "base_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"base_name" text NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" bigint NOT NULL,
	"table_count" integer NOT NULL,
	"record_count" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_snapshots_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "base_snapshots_kind_check" CHECK ("base_snapshots"."kind" IN ('manual', 'auto'))
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_storage_key_unique";--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "snapshot_retention_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "base_snapshots" ADD CONSTRAINT "base_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_snapshots" ADD CONSTRAINT "base_snapshots_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "base_snapshots_base_id_idx" ON "base_snapshots" USING btree ("base_id","created_at");--> statement-breakpoint
CREATE INDEX "base_snapshots_workspace_id_idx" ON "base_snapshots" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "attachments_storage_key_idx" ON "attachments" USING btree ("storage_key");