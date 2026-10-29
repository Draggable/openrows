CREATE TABLE "base_members" (
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_members_base_id_user_id_pk" PRIMARY KEY("base_id","user_id"),
	CONSTRAINT "base_members_role_check" CHECK (role IN ('creator', 'editor', 'commenter', 'read_only'))
);
--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_role_check";--> statement-breakpoint
-- Hand-added: rename the old roles before the new check applies (Airtable's ladder, #13).
UPDATE "workspace_members" SET "role" = CASE "role" WHEN 'admin' THEN 'creator' WHEN 'viewer' THEN 'read_only' ELSE "role" END;--> statement-breakpoint
ALTER TABLE "base_members" ADD CONSTRAINT "base_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_members" ADD CONSTRAINT "base_members_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "base_members_user_id_idx" ON "base_members" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_role_check" CHECK (role IN ('owner', 'creator', 'editor', 'commenter', 'read_only'));