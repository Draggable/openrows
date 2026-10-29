CREATE TABLE "legal_notice_deliveries" (
	"notice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_notice_deliveries_notice_id_user_id_pk" PRIMARY KEY("notice_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "legal_notice_dismissals" (
	"notice_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_notice_dismissals_notice_id_user_id_pk" PRIMARY KEY("notice_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "legal_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"audience" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"url" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_notices_kind_check" CHECK ("legal_notices"."kind" IN ('terms', 'privacy', 'price', 'plan', 'service')),
	CONSTRAINT "legal_notices_audience_check" CHECK ("legal_notices"."audience" IN ('everyone', 'owners'))
);
--> statement-breakpoint
ALTER TABLE "legal_notice_deliveries" ADD CONSTRAINT "legal_notice_deliveries_notice_id_legal_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."legal_notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_notice_deliveries" ADD CONSTRAINT "legal_notice_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_notice_dismissals" ADD CONSTRAINT "legal_notice_dismissals_notice_id_legal_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."legal_notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_notice_dismissals" ADD CONSTRAINT "legal_notice_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_notice_deliveries_run_idx" ON "legal_notice_deliveries" USING btree ("notice_id","run_id");--> statement-breakpoint
CREATE INDEX "legal_notices_effective_idx" ON "legal_notices" USING btree ("effective_at");