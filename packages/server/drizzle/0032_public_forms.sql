CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"share_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_submissions_share_submission_unique" UNIQUE("share_id","submission_id")
);
--> statement-breakpoint
ALTER TABLE "shares" DROP CONSTRAINT "shares_kind_check";--> statement-breakpoint
ALTER TABLE "shares" DROP CONSTRAINT "shares_view_check";--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "share_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "record_id" uuid;--> statement-breakpoint
ALTER TABLE "record_revisions" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_table_fk" FOREIGN KEY ("workspace_id","table_id") REFERENCES "public"."tables"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_submissions_workspace_id_idx" ON "form_submissions" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_form_check" CHECK ("attachments"."share_id" IS NULL OR "attachments"."field_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "record_revisions" ADD CONSTRAINT "record_revisions_via_check" CHECK ("record_revisions"."via" IS NULL OR "record_revisions"."via" IN ('form'));--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_kind_check" CHECK ("shares"."kind" IN ('view', 'base', 'form'));--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_view_check" CHECK (("shares"."kind" IN ('view', 'form')) = ("shares"."view_id" IS NOT NULL));