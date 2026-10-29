ALTER TABLE "shares" DROP CONSTRAINT "shares_kind_check";--> statement-breakpoint
ALTER TABLE "shares" DROP CONSTRAINT "shares_view_check";--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "password_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "allowed_domains" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "allow_copy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "allow_download" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "shares_base_id_idx" ON "shares" USING btree ("base_id");--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_password_hash_check" CHECK ("shares"."password_hash" IS NULL OR "shares"."password_hash" LIKE '$argon2id$%');--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_allowed_domains_check" CHECK (cardinality("shares"."allowed_domains") <= 20);--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_kind_check" CHECK ("shares"."kind" IN ('view', 'base'));--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_view_check" CHECK (("shares"."kind" = 'view') = ("shares"."view_id" IS NOT NULL));