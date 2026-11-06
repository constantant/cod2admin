ALTER TABLE "admins" ADD COLUMN "is_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "admins" SET "is_owner" = true WHERE "role" = 'owner';--> statement-breakpoint
CREATE TABLE "admin_permissions" (
	"telegram_id" bigint NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "admin_permissions_telegram_id_permission_pk" PRIMARY KEY("telegram_id","permission")
);
--> statement-breakpoint
ALTER TABLE "admin_permissions" ADD CONSTRAINT "admin_permissions_telegram_id_admins_telegram_id_fk" FOREIGN KEY ("telegram_id") REFERENCES "public"."admins"("telegram_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "admin_permissions" ("telegram_id", "permission")
SELECT "admins"."telegram_id", perm.permission
FROM "admins"
CROSS JOIN (VALUES
	('kick'),
	('tempban'),
	('mute')
) AS perm(permission)
WHERE "admins"."role" = 'moderator';--> statement-breakpoint
INSERT INTO "admin_permissions" ("telegram_id", "permission")
SELECT "admins"."telegram_id", perm.permission
FROM "admins"
CROSS JOIN (VALUES
	('kick'),
	('tempban'),
	('mute'),
	('ban'),
	('say'),
	('maps'),
	('presets'),
	('vpn'),
	('cvars.read'),
	('servers.view'),
	('servers.assign'),
	('notes.manage'),
	('admins.manage')
) AS perm(permission)
WHERE "admins"."role" = 'admin';--> statement-breakpoint
DROP INDEX "admins_one_owner_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "admins_one_owner_idx" ON "admins" USING btree ("is_owner") WHERE "admins"."is_owner" = true;--> statement-breakpoint
ALTER TABLE "admins" DROP COLUMN "role";--> statement-breakpoint
DROP TYPE "public"."admin_role";
