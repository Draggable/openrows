CREATE TABLE "workspace_scim_group_members" (
	"workspace_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"scim_user_id" uuid NOT NULL,
	CONSTRAINT "workspace_scim_group_members_group_id_scim_user_id_pk" PRIMARY KEY("group_id","scim_user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_scim_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_scim_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text,
	"token_hint" text,
	"token_created_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"default_role" text DEFAULT 'editor' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_scim_settings_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "workspace_scim_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_name" text NOT NULL,
	"external_id" text,
	"email" text NOT NULL,
	"given_name" text,
	"family_name" text,
	"display_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_scim_group_members" ADD CONSTRAINT "workspace_scim_group_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_scim_group_members" ADD CONSTRAINT "workspace_scim_group_members_group_id_workspace_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."workspace_scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_scim_group_members" ADD CONSTRAINT "workspace_scim_group_members_scim_user_id_workspace_scim_users_id_fk" FOREIGN KEY ("scim_user_id") REFERENCES "public"."workspace_scim_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_scim_groups" ADD CONSTRAINT "workspace_scim_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_scim_settings" ADD CONSTRAINT "workspace_scim_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_scim_settings" ADD CONSTRAINT "workspace_scim_settings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_scim_users" ADD CONSTRAINT "workspace_scim_users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_scim_users" ADD CONSTRAINT "workspace_scim_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_scim_group_members_user_idx" ON "workspace_scim_group_members" USING btree ("scim_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_scim_groups_name_idx" ON "workspace_scim_groups" USING btree ("workspace_id",lower("display_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_scim_users_user_name_idx" ON "workspace_scim_users" USING btree ("workspace_id",lower("user_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_scim_users_email_idx" ON "workspace_scim_users" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_scim_users_user_idx" ON "workspace_scim_users" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_scim_users_pending_idx" ON "workspace_scim_users" USING btree ("email") WHERE "workspace_scim_users"."user_id" IS NULL;