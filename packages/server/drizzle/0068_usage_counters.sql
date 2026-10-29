CREATE TABLE "api_call_counts" (
	"workspace_id" uuid NOT NULL,
	"month" date NOT NULL,
	"calls" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "api_call_counts_pk" PRIMARY KEY("workspace_id","month")
);
--> statement-breakpoint
CREATE TABLE "table_record_counts" (
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"records" bigint DEFAULT 0 NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "table_record_counts_pk" PRIMARY KEY("table_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "plan_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "api_call_counts" ADD CONSTRAINT "api_call_counts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_counts" ADD CONSTRAINT "table_record_counts_table_fk" FOREIGN KEY ("workspace_id","table_id") REFERENCES "public"."tables"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "table_record_counts_base_id_idx" ON "table_record_counts" USING btree ("base_id");