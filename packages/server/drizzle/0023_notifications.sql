CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"base_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"comment_id" uuid,
	"field_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"email_state" text DEFAULT 'pending' NOT NULL,
	"emailed_at" timestamp with time zone,
	CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" IN ('mention', 'reply', 'assigned')),
	CONSTRAINT "notifications_email_state_check" CHECK ("notifications"."email_state" IN ('pending', 'sending', 'sent', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_email" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_table_fk" FOREIGN KEY ("workspace_id","table_id") REFERENCES "public"."tables"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_fk" FOREIGN KEY ("workspace_id","comment_id") REFERENCES "public"."record_comments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_workspace_id_idx" ON "notifications" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_pending_idx" ON "notifications" USING btree ("created_at") WHERE "notifications"."email_state" = 'pending';--> statement-breakpoint
CREATE INDEX "notifications_emailed_idx" ON "notifications" USING btree ("user_id","record_id","emailed_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_notification_email_check" CHECK ("users"."notification_email" IN ('all', 'mentions', 'none'));