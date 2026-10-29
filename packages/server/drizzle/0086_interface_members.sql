CREATE TABLE "interface_members" (
	"workspace_id" uuid NOT NULL,
	"interface_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interface_members_interface_id_user_id_pk" PRIMARY KEY("interface_id","user_id"),
	CONSTRAINT "interface_members_role_check" CHECK (role IN ('editor', 'read_only'))
);
--> statement-breakpoint
DROP INDEX "workspace_invitations_pending_base_email_idx";--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD COLUMN "interface_id" uuid;--> statement-breakpoint
ALTER TABLE "interface_members" ADD CONSTRAINT "interface_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_members" ADD CONSTRAINT "interface_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_members" ADD CONSTRAINT "interface_members_interface_fk" FOREIGN KEY ("workspace_id","interface_id") REFERENCES "public"."interfaces"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "interface_members_user_id_idx" ON "interface_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "interface_members_workspace_id_idx" ON "interface_members" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_interface_fk" FOREIGN KEY ("workspace_id","interface_id") REFERENCES "public"."interfaces"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_pending_interface_email_idx" ON "workspace_invitations" USING btree ("interface_id","email") WHERE "workspace_invitations"."accepted_at" IS NULL AND "workspace_invitations"."revoked_at" IS NULL AND "workspace_invitations"."interface_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitations_pending_base_email_idx" ON "workspace_invitations" USING btree ("base_id","email") WHERE "workspace_invitations"."accepted_at" IS NULL AND "workspace_invitations"."revoked_at" IS NULL AND "workspace_invitations"."base_id" IS NOT NULL AND "workspace_invitations"."interface_id" IS NULL;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_interface_role_check" CHECK (interface_id IS NULL OR (base_id IS NOT NULL AND role IN ('editor', 'read_only')));