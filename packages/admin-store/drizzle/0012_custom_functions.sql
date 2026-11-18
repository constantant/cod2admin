CREATE TABLE "custom_functions" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"icon" text,
	"kind" text NOT NULL,
	"definition" jsonb NOT NULL,
	"server_alias" text,
	"requires" text,
	"dangerous" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_functions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE INDEX "custom_functions_server_idx" ON "custom_functions" USING btree ("server_alias");