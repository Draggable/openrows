CREATE TABLE "automation_email_counts" (
	"workspace_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "automation_email_counts_pk" PRIMARY KEY("workspace_id","day")
);
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT "automations_trigger_type_check";--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "triggered_by" uuid;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "secrets_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "hook_token_hash" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "hook_token_encrypted" "bytea";--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "hook_sample" jsonb;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "hook_sample_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_email_counts" ADD CONSTRAINT "automation_email_counts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automations_hook_token_hash_unique" ON "automations" USING btree ("hook_token_hash") WHERE "automations"."hook_token_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_trigger_type_check" CHECK ("automations"."trigger_type" IN ('recordCreated', 'recordUpdated', 'recordMatches', 'scheduled', 'formSubmitted', 'webhookReceived', 'buttonClicked'));