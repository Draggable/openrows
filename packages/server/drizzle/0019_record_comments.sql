CREATE TABLE "record_comment_reactions" (
	"workspace_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reaction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "record_comment_reactions_comment_id_user_id_reaction_pk" PRIMARY KEY("comment_id","user_id","reaction"),
	CONSTRAINT "record_comment_reactions_reaction_check" CHECK (char_length("record_comment_reactions"."reaction") <= 32)
);
--> statement-breakpoint
CREATE TABLE "record_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"mentions" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "record_comments_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "record_comments_body_check" CHECK (char_length("record_comments"."body") BETWEEN 1 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "record_comment_reactions" ADD CONSTRAINT "record_comment_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_comment_reactions" ADD CONSTRAINT "record_comment_reactions_comment_fk" FOREIGN KEY ("workspace_id","comment_id") REFERENCES "public"."record_comments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_comments" ADD CONSTRAINT "record_comments_table_fk" FOREIGN KEY ("workspace_id","table_id") REFERENCES "public"."tables"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_comment_reactions_workspace_id_idx" ON "record_comment_reactions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "record_comments_workspace_id_idx" ON "record_comments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "record_comments_record_idx" ON "record_comments" USING btree ("table_id","record_id","created_at");