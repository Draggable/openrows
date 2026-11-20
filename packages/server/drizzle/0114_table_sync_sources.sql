-- A synced table may sync from more than one source: one table_syncs row per source, and the
-- "Sync source ID" field (owner_field_id) that names the source of each record once there are two.
DROP INDEX "table_syncs_table_id_unique";--> statement-breakpoint
ALTER TABLE "table_syncs" ADD COLUMN "owner_field_id" uuid;--> statement-breakpoint
ALTER TABLE "table_syncs" ADD COLUMN "owns_unattributed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "table_syncs_table_id_idx" ON "table_syncs" USING btree ("table_id","created_at");