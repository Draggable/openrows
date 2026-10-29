CREATE TABLE "outbox_relay_cursor" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"txid" "xid8" NOT NULL,
	"outbox_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_relay_cursor_one_row" CHECK ("outbox_relay_cursor"."id" = 1)
);
--> statement-breakpoint
-- Two steps, so existing rows stay null instead of the whole table being rewritten.
ALTER TABLE "outbox" ADD COLUMN "txid" "xid8";--> statement-breakpoint
ALTER TABLE "outbox" ALTER COLUMN "txid" SET DEFAULT pg_current_xact_id();--> statement-breakpoint
CREATE INDEX "outbox_txid_id_idx" ON "outbox" USING btree ("txid","id");