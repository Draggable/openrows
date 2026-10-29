ALTER TABLE "attachments" ALTER COLUMN "field_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "view_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_view_fk" FOREIGN KEY ("workspace_id","view_id") REFERENCES "public"."views"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_owner_check" CHECK (("attachments"."field_id" IS NULL) <> ("attachments"."view_id" IS NULL));