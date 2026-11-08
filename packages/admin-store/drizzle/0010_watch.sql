ALTER TABLE "servers" ADD COLUMN "watch" jsonb;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "watch_private_password_encrypted" text;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "watch_private_password_owned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "origin" text DEFAULT 'player' NOT NULL;
