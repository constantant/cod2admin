ALTER TYPE "public"."audit_source" ADD VALUE 'mcp';
--> statement-breakpoint
CREATE TABLE "mcp_pending" (
	"public_id" text PRIMARY KEY NOT NULL,
	"approve_hash" text NOT NULL,
	"browser_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"telegram_id" bigint,
	"permissions" text[],
	"decision" text,
	"code_issued" boolean DEFAULT false NOT NULL,
	CONSTRAINT "mcp_pending_approve_hash_unique" UNIQUE("approve_hash"),
	CONSTRAINT "mcp_pending_browser_hash_unique" UNIQUE("browser_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"permissions" text[] NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_grant_id" text,
	CONSTRAINT "mcp_codes_telegram_id_admins_telegram_id_fk" FOREIGN KEY ("telegram_id") REFERENCES "public"."admins"("telegram_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "mcp_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_host" text NOT NULL,
	"permissions" text[] NOT NULL,
	"scope" text NOT NULL,
	"resource" text NOT NULL,
	"refresh_hash" text NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mcp_grants_refresh_hash_unique" UNIQUE("refresh_hash"),
	CONSTRAINT "mcp_grants_telegram_id_admins_telegram_id_fk" FOREIGN KEY ("telegram_id") REFERENCES "public"."admins"("telegram_id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "mcp_grants_telegram_idx" ON "mcp_grants" USING btree ("telegram_id");
--> statement-breakpoint
CREATE TABLE "mcp_retired_refresh" (
	"refresh_hash" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	CONSTRAINT "mcp_retired_refresh_grant_id_mcp_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "mcp_access" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mcp_access_grant_id_mcp_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE cascade ON UPDATE no action
);
