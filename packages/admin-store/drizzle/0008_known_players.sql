CREATE TABLE "known_players" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display" text NOT NULL,
	"asns" bigint[] NOT NULL,
	"note" text,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "known_players_name_unique" UNIQUE("name")
);
