ALTER TABLE "attachments" DROP CONSTRAINT "attachments_status_check";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "scan_result" text;--> statement-breakpoint
CREATE INDEX "attachments_scanning_idx" ON "attachments" USING btree ("confirmed_at") WHERE "attachments"."status" = 'scanning';--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_status_check" CHECK ("attachments"."status" IN ('pending', 'scanning', 'ready', 'infected'));