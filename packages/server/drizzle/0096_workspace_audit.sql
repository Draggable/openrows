CREATE TABLE "workspace_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" uuid,
	"actor_email" text,
	"ip" "inet",
	"user_agent" text,
	"target_type" text NOT NULL,
	"target_id" text,
	"target_name" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_audit_streams" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"secret_encrypted" "bytea" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor" uuid,
	"last_delivery_at" timestamp with time zone,
	"last_error" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_audit_streams" ADD CONSTRAINT "workspace_audit_streams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_audit_streams" ADD CONSTRAINT "workspace_audit_streams_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_audit_events_workspace_idx" ON "workspace_audit_events" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "workspace_audit_events_action_idx" ON "workspace_audit_events" USING btree ("workspace_id","action","id");--> statement-breakpoint
CREATE INDEX "workspace_audit_events_actor_idx" ON "workspace_audit_events" USING btree ("workspace_id","actor_id","id");