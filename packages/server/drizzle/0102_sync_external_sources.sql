ALTER TABLE "table_syncs" ALTER COLUMN "source_workspace_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "table_syncs" ALTER COLUMN "source_base_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "table_syncs" ALTER COLUMN "source_table_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "table_syncs" ADD COLUMN "source_kind" text DEFAULT 'table' NOT NULL;--> statement-breakpoint
ALTER TABLE "table_syncs" ADD COLUMN "source_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "table_syncs" ADD COLUMN "source_secret" "bytea";--> statement-breakpoint
ALTER TABLE "table_syncs" ADD COLUMN "source_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "table_syncs" ADD COLUMN "key_column" text;--> statement-breakpoint
-- #155: a table source names its table; an external one (CSV URL, Postgres) has its secret.
ALTER TABLE "table_syncs" ADD CONSTRAINT "table_syncs_source_check" CHECK (
  (source_kind = 'table' AND source_workspace_id IS NOT NULL AND source_base_id IS NOT NULL
    AND source_table_id IS NOT NULL)
  OR (source_kind IN ('csv', 'postgres') AND source_secret IS NOT NULL)
);
