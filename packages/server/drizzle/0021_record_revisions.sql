CREATE TABLE "record_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_op_id" text,
	"restored_from" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_revisions_kind_check" CHECK ("record_revisions"."kind" IN ('created', 'updated', 'deleted', 'restored'))
);
--> statement-breakpoint
ALTER TABLE "record_revisions" ADD CONSTRAINT "record_revisions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_revisions" ADD CONSTRAINT "record_revisions_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_revisions" ADD CONSTRAINT "record_revisions_table_fk" FOREIGN KEY ("workspace_id","table_id") REFERENCES "public"."tables"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_revisions_workspace_id_idx" ON "record_revisions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "record_revisions_record_idx" ON "record_revisions" USING btree ("base_id","record_id","created_at");--> statement-breakpoint
CREATE INDEX "record_revisions_created_at_idx" ON "record_revisions" USING btree ("created_at");