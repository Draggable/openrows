CREATE TABLE "workspace_sso_connections" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"alias" text NOT NULL,
	"protocol" text NOT NULL,
	"display_name" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"require_sso" boolean DEFAULT false NOT NULL,
	"jit" boolean DEFAULT true NOT NULL,
	"default_role" text DEFAULT 'editor' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sso_connections_alias_unique" UNIQUE("alias")
);
--> statement-breakpoint
CREATE TABLE "workspace_sso_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sso_domains_workspace_domain" UNIQUE("workspace_id","domain")
);
--> statement-breakpoint
ALTER TABLE "workspace_sso_connections" ADD CONSTRAINT "workspace_sso_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sso_connections" ADD CONSTRAINT "workspace_sso_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sso_domains" ADD CONSTRAINT "workspace_sso_domains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_sso_domains" ADD CONSTRAINT "workspace_sso_domains_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_sso_domains_verified_idx" ON "workspace_sso_domains" USING btree ("domain") WHERE "workspace_sso_domains"."verified_at" IS NOT NULL;