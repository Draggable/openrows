CREATE TABLE "automation_matches" (
	"workspace_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	CONSTRAINT "automation_matches_pk" PRIMARY KEY("automation_id","record_id")
);
--> statement-breakpoint
CREATE TABLE "automation_run_counts" (
	"workspace_id" uuid NOT NULL,
	"month" date NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "automation_run_counts_pk" PRIMARY KEY("workspace_id","month")
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"depth" smallint NOT NULL,
	"trigger" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"outbox_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_idempotency_unique" UNIQUE("automation_id","idempotency_key"),
	CONSTRAINT "automation_runs_status_check" CHECK ("automation_runs"."status" IN ('succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"disabled_reason" text,
	"trigger" jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger_type" text NOT NULL,
	"table_id" uuid,
	"armed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_by" uuid,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "automations_trigger_type_check" CHECK ("automations"."trigger_type" IN ('recordCreated', 'recordUpdated', 'recordMatches', 'scheduled')),
	CONSTRAINT "automations_disabled_reason_check" CHECK ("automations"."disabled_reason" IS NULL OR "automations"."disabled_reason" IN ('creator_access')),
	CONSTRAINT "automations_last_run_status_check" CHECK ("automations"."last_run_status" IS NULL OR "automations"."last_run_status" IN ('succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "automation_id" uuid DEFAULT nullif(current_setting('app.automation_id', true), '')::uuid;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "automation_depth" smallint DEFAULT nullif(current_setting('app.automation_depth', true), '')::smallint;--> statement-breakpoint
ALTER TABLE "automation_matches" ADD CONSTRAINT "automation_matches_automation_fk" FOREIGN KEY ("workspace_id","automation_id") REFERENCES "public"."automations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_run_counts" ADD CONSTRAINT "automation_run_counts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_fk" FOREIGN KEY ("workspace_id","automation_id") REFERENCES "public"."automations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_matches_workspace_id_idx" ON "automation_matches" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "automation_runs_automation_id_idx" ON "automation_runs" USING btree ("automation_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_created_at_idx" ON "automation_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_workspace_id_idx" ON "automation_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "automations_base_id_idx" ON "automations" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "automations_workspace_id_idx" ON "automations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "automations_next_run_at_idx" ON "automations" USING btree ("next_run_at") WHERE "automations"."enabled" AND "automations"."next_run_at" IS NOT NULL;