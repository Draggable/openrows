ALTER TABLE "fields" ADD COLUMN "permissions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "permissions" jsonb DEFAULT '{}'::jsonb NOT NULL;