ALTER TABLE "automation_runs" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_skip_reason_check" CHECK ("automation_runs"."skip_reason" IS NULL OR "automation_runs"."skip_reason" IN ('loop', 'quota'));--> statement-breakpoint
-- Every run skipped so far was the loop guard's (#129 adds the quota's).
UPDATE "automation_runs" SET "skip_reason" = 'loop' WHERE "status" = 'skipped';
