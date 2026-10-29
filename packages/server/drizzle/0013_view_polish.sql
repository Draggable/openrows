CREATE TABLE "view_sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"table_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "view_sections_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "views" ADD COLUMN "section_id" uuid;--> statement-breakpoint
ALTER TABLE "view_sections" ADD CONSTRAINT "view_sections_table_fk" FOREIGN KEY ("workspace_id","table_id") REFERENCES "public"."tables"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "view_sections_table_id_idx" ON "view_sections" USING btree ("table_id");--> statement-breakpoint
ALTER TABLE "views" ADD CONSTRAINT "views_section_id_view_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."view_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "views_section_id_idx" ON "views" USING btree ("section_id");