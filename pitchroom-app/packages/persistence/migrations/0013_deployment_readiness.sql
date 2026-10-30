CREATE TABLE "deployment_identity" (
	"singleton" integer PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"database_target" text NOT NULL,
	"database_name" text NOT NULL,
	"runtime_role" text NOT NULL,
	"target_receipt_sha" text NOT NULL,
	CONSTRAINT "deployment_identity_singleton" CHECK ("deployment_identity"."singleton" = 1)
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"instance_id" uuid PRIMARY KEY NOT NULL,
	"environment_id" uuid NOT NULL,
	"release_sha" text NOT NULL,
	"schema_version" text NOT NULL,
	"configuration_hash" text NOT NULL,
	"state" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worker_heartbeats_state" CHECK ("worker_heartbeats"."state" in ('ready', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX "worker_heartbeats_seen_idx" ON "worker_heartbeats" USING btree ("seen_at");