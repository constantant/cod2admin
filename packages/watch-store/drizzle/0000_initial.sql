CREATE TABLE "watch_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_alias" text NOT NULL,
	"profile_key" text NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"life_score" real NOT NULL,
	"features" jsonb NOT NULL,
	"trace" jsonb,
	"report_id" integer
);
--> statement-breakpoint
CREATE TABLE "watch_lives" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_alias" text NOT NULL,
	"profile_key" text NOT NULL,
	"map_name" text,
	"end_reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"features" jsonb NOT NULL,
	"life_score" real,
	"features_over_flag" integer NOT NULL,
	"aim_agreeing" integer NOT NULL,
	"excluded_from_population" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_population_days" (
	"server_alias" text NOT NULL,
	"map_name" text NOT NULL,
	"weapon_class" text NOT NULL,
	"feature" text NOT NULL,
	"day" date NOT NULL,
	"n" integer NOT NULL,
	"mean" double precision NOT NULL,
	"m2" double precision NOT NULL,
	CONSTRAINT "watch_population_days_server_alias_map_name_weapon_class_feature_day_pk" PRIMARY KEY("server_alias","map_name","weapon_class","feature","day")
);
--> statement-breakpoint
CREATE TABLE "watch_profile_names" (
	"server_alias" text NOT NULL,
	"profile_key" text NOT NULL,
	"stripped_name" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "watch_profile_names_server_alias_profile_key_stripped_name_pk" PRIMARY KEY("server_alias","profile_key","stripped_name")
);
--> statement-breakpoint
CREATE TABLE "watch_profiles" (
	"server_alias" text NOT NULL,
	"profile_key" text NOT NULL,
	"kind" text NOT NULL,
	"display_name" text,
	"last_guid" text,
	"last_ip" text,
	"life_count" integer DEFAULT 0 NOT NULL,
	"self_moments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "watch_profiles_server_alias_profile_key_pk" PRIMARY KEY("server_alias","profile_key")
);
--> statement-breakpoint
CREATE INDEX "watch_evidence_server_created_idx" ON "watch_evidence" USING btree ("server_alias","created_at");--> statement-breakpoint
CREATE INDEX "watch_evidence_server_profile_created_idx" ON "watch_evidence" USING btree ("server_alias","profile_key","created_at");--> statement-breakpoint
CREATE INDEX "watch_lives_server_ended_idx" ON "watch_lives" USING btree ("server_alias","ended_at");--> statement-breakpoint
CREATE INDEX "watch_lives_server_profile_ended_idx" ON "watch_lives" USING btree ("server_alias","profile_key","ended_at");