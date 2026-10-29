CREATE TABLE "billing_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"subject_workspace_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"subscription_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"plan" text NOT NULL,
	"interval" text NOT NULL,
	"status" text NOT NULL,
	"entitled" boolean NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"current_period_end" timestamp with time zone,
	"changed_at" timestamp (6) with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_received_idx" ON "billing_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_provider_id_uq" ON "billing_subscriptions" USING btree ("provider","subscription_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_workspace_idx" ON "billing_subscriptions" USING btree ("workspace_id");