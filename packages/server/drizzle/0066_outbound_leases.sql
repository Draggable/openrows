CREATE TABLE "outbound_leases" (
	"key" text NOT NULL,
	"slot" integer NOT NULL,
	"holder" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "outbound_leases_key_slot_pk" PRIMARY KEY("key","slot")
);
