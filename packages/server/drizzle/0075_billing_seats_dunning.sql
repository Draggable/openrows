ALTER TABLE "billing_subscriptions" ADD COLUMN "seats" integer;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "seats_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "past_due_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "dunning_stage" smallint DEFAULT 0 NOT NULL;