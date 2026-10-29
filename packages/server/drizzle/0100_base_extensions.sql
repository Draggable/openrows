CREATE TABLE "base_extensions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"base_id" uuid NOT NULL,
	"built_in" text,
	"name" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"bundle" jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"size" text DEFAULT 'medium' NOT NULL,
	"position" integer NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "base_extensions" ADD CONSTRAINT "base_extensions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_extensions" ADD CONSTRAINT "base_extensions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_extensions" ADD CONSTRAINT "base_extensions_base_fk" FOREIGN KEY ("workspace_id","base_id") REFERENCES "public"."bases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "base_extensions_base_id_idx" ON "base_extensions" USING btree ("base_id");