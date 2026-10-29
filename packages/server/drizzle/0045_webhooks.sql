CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"outbox_id" bigint,
	"attempt" integer NOT NULL,
	"success" boolean NOT NULL,
	"response_status" integer,
	"duration_ms" integer NOT NULL,
	"response_body" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"events" text[] NOT NULL,
	"table_ids" uuid[],
	"field_ids" uuid[],
	"secret_encrypted" "bytea" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failing_since" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"last_success" boolean,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "webhooks_events_check" CHECK (cardinality("webhooks"."events") > 0),
	CONSTRAINT "webhooks_disabled_reason_check" CHECK ("webhooks"."disabled_reason" IS NULL OR "webhooks"."disabled_reason" IN ('failures', 'creator_access'))
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_fk" FOREIGN KEY ("workspace_id","webhook_id") REFERENCES "public"."webhooks"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_id_idx" ON "webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_workspace_id_idx" ON "webhook_deliveries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "webhooks_base_id_idx" ON "webhooks" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "webhooks_workspace_id_idx" ON "webhooks" USING btree ("workspace_id");