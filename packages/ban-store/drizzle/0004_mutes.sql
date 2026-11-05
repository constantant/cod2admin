CREATE TABLE "mutes" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_alias" text NOT NULL,
	"name" text NOT NULL,
	"guid" text,
	"ip" text,
	"reason" text,
	"muted_by" bigint NOT NULL,
	"muted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"unmuted_at" timestamp with time zone
);
