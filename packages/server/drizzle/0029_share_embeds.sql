ALTER TABLE "shares" ADD COLUMN "embed_origins" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "allow_restricted_embed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_embed_origins_check" CHECK (cardinality("shares"."embed_origins") <= 20);