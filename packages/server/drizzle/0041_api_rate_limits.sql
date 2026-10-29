CREATE TABLE "personal_access_token_usage" (
	"token_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "personal_access_token_usage_token_id_day_pk" PRIMARY KEY("token_id","day")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_access_token_usage" ADD CONSTRAINT "personal_access_token_usage_token_id_personal_access_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_token_usage" ADD CONSTRAINT "personal_access_token_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_access_token_usage_user_id_idx" ON "personal_access_token_usage" USING btree ("user_id");