ALTER TABLE "ban_ips" ADD COLUMN "unbanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bans" ADD COLUMN "unbanned_at" timestamp with time zone;