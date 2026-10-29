CREATE TABLE "ai_credit_counts" (
	"workspace_id" uuid NOT NULL,
	"month" date NOT NULL,
	"credits" bigint DEFAULT 0 NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_credit_counts_pk" PRIMARY KEY("workspace_id","month")
);
--> statement-breakpoint
ALTER TABLE "ai_credit_counts" ADD CONSTRAINT "ai_credit_counts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;