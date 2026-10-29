CREATE TABLE "sync_connector_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"label" text NOT NULL,
	"tokens_encrypted" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_connector_accounts_user_connector_unique" UNIQUE("user_id","connector")
);
--> statement-breakpoint
ALTER TABLE "sync_connector_accounts" ADD CONSTRAINT "sync_connector_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;