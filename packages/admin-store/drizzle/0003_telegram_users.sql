CREATE TABLE "telegram_users" (
	"telegram_id" bigint PRIMARY KEY NOT NULL,
	"username" text,
	"first_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
