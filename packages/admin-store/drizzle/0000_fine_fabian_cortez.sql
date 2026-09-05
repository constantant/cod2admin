CREATE TYPE "public"."admin_role" AS ENUM('owner', 'admin', 'moderator');--> statement-breakpoint
CREATE TYPE "public"."audit_source" AS ENUM('telegram_button', 'telegram_command', 'auto');--> statement-breakpoint
CREATE TABLE "admin_servers" (
	"telegram_id" bigint NOT NULL,
	"server_alias" text NOT NULL,
	CONSTRAINT "admin_servers_telegram_id_server_alias_pk" PRIMARY KEY("telegram_id","server_alias")
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"telegram_id" bigint PRIMARY KEY NOT NULL,
	"role" "admin_role" NOT NULL,
	"added_by" bigint,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_telegram_id" bigint NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"server_alias" text,
	"reason" text,
	"source" "audit_source" NOT NULL,
	"detail_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"alias" text PRIMARY KEY NOT NULL,
	"rcon_host" text NOT NULL,
	"rcon_port" bigint NOT NULL,
	"rcon_password_encrypted" text NOT NULL,
	"log_source_config" text,
	"bound_telegram_chat_id" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admins_one_owner_idx" ON "admins" USING btree ("role") WHERE "admins"."role" = 'owner';