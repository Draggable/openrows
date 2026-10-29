ALTER TABLE "bases" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "fields" ADD COLUMN "trashed_with" uuid;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;