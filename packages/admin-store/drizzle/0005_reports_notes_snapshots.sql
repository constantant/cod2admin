CREATE TYPE "public"."player_note_kind" AS ENUM('guid', 'ip', 'name');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'handled', 'ignored');--> statement-breakpoint
CREATE TABLE "player_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "player_note_kind" NOT NULL,
	"value" text NOT NULL,
	"note" text NOT NULL,
	"watch" boolean DEFAULT false NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_alias" text NOT NULL,
	"reporter_name" text NOT NULL,
	"reporter_guid" text,
	"target_name" text NOT NULL,
	"reason" text,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" bigint,
	"resolved_at" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "server_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_alias" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"online" boolean NOT NULL,
	"player_count" integer DEFAULT 0 NOT NULL,
	"max_clients" integer,
	"map" text,
	"gametype" text
);
--> statement-breakpoint
CREATE INDEX "player_notes_value_idx" ON "player_notes" USING btree ("kind","value");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status","last_reported_at");--> statement-breakpoint
CREATE INDEX "server_snapshots_alias_at_idx" ON "server_snapshots" USING btree ("server_alias","at");