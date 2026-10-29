CREATE TABLE "ai_field_cells" (
	"workspace_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"requested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_field_cells_field_id_record_id_pk" PRIMARY KEY("field_id","record_id"),
	CONSTRAINT "ai_field_cells_status_check" CHECK ("ai_field_cells"."status" IN ('pending', 'done', 'error', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "ai_field_cells" ADD CONSTRAINT "ai_field_cells_field_fk" FOREIGN KEY ("workspace_id","field_id") REFERENCES "public"."fields"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_field_cells_status_idx" ON "ai_field_cells" USING btree ("field_id","status","requested_at");--> statement-breakpoint
CREATE INDEX "ai_field_cells_workspace_id_idx" ON "ai_field_cells" USING btree ("workspace_id");