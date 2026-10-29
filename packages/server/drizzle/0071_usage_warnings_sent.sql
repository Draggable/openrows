CREATE TABLE "usage_warnings_sent" (
	"workspace_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"level" text NOT NULL,
	"month" date NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_warnings_sent_pk" PRIMARY KEY("workspace_id","metric","subject","level","month")
);
--> statement-breakpoint
ALTER TABLE "usage_warnings_sent" ADD CONSTRAINT "usage_warnings_sent_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;