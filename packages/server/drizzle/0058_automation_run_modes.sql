ALTER TABLE "automation_runs" ADD COLUMN "mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "retry_of" uuid;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_mode_check" CHECK ("automation_runs"."mode" IN ('live', 'test', 'retry'));