CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"table_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_by" uuid,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_import_table_check" CHECK ("jobs"."kind" <> 'import' OR "jobs"."table_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "storage_garbage" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "storage_garbage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_garbage_kind_check" CHECK ("storage_garbage"."kind" IN ('pending', 'file', 'snapshot'))
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_workspace_id_idx" ON "jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "jobs_finished_at_idx" ON "jobs" USING btree ("finished_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_import_per_table" ON "jobs" USING btree ("table_id") WHERE "jobs"."kind" = 'import' AND "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "storage_garbage_workspace_idx" ON "storage_garbage" USING btree ("workspace_id","id");