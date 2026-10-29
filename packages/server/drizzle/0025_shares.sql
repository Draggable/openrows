CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"view_id" uuid,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "shares_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "shares_kind_check" CHECK ("shares"."kind" IN ('view')),
	CONSTRAINT "shares_view_check" CHECK ("shares"."kind" <> 'view' OR "shares"."view_id" IS NOT NULL),
	CONSTRAINT "shares_token_hash_check" CHECK ("shares"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_view_fk" FOREIGN KEY ("workspace_id","view_id") REFERENCES "public"."views"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shares_view_id_idx" ON "shares" USING btree ("view_id");--> statement-breakpoint
CREATE INDEX "shares_workspace_id_idx" ON "shares" USING btree ("workspace_id");