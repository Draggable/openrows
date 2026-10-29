CREATE TABLE "workspace_member_activity" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_member_activity_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_policies" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"share_links" boolean DEFAULT true NOT NULL,
	"public_forms" boolean DEFAULT true NOT NULL,
	"embeds" boolean DEFAULT true NOT NULL,
	"personal_access_tokens" boolean DEFAULT true NOT NULL,
	"invite_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_member_activity" ADD CONSTRAINT "workspace_member_activity_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member_activity" ADD CONSTRAINT "workspace_member_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_policies" ADD CONSTRAINT "workspace_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_policies" ADD CONSTRAINT "workspace_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;