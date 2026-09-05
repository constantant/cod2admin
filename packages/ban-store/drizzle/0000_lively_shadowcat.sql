CREATE TABLE "ban_ips" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_alias" text NOT NULL,
	"ip" text NOT NULL,
	"reason" text,
	"banned_by" bigint NOT NULL,
	"banned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bans" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_alias" text NOT NULL,
	"guid" text,
	"name" text NOT NULL,
	"reason" text,
	"banned_by" bigint NOT NULL,
	"banned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
