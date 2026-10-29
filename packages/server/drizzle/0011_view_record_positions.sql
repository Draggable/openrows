CREATE TABLE "view_record_positions" (
	"workspace_id" uuid NOT NULL,
	"view_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"position" double precision NOT NULL,
	CONSTRAINT "view_record_positions_view_id_record_id_pk" PRIMARY KEY("view_id","record_id")
);
--> statement-breakpoint
ALTER TABLE "view_record_positions" ADD CONSTRAINT "view_record_positions_view_fk" FOREIGN KEY ("workspace_id","view_id") REFERENCES "public"."views"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "view_record_positions_workspace_id_idx" ON "view_record_positions" USING btree ("workspace_id");