ALTER TABLE "projects" ADD COLUMN "current_deck_id" uuid;
CREATE TABLE "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "target_revision" integer NOT NULL,
  "model" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "result_id" uuid,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
CREATE UNIQUE INDEX "workflow_runs_project_idempotency_unique" ON "workflow_runs" ("project_id", "idempotency_key");
CREATE INDEX "workflow_runs_project_started_idx" ON "workflow_runs" ("project_id", "started_at");
CREATE TABLE "deck_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "understanding_id" uuid NOT NULL REFERENCES "understanding_versions"("id") ON DELETE restrict,
  "positioning_id" uuid NOT NULL REFERENCES "positioning_versions"("id") ON DELETE restrict,
  "applied_direction_id" text NOT NULL,
  "version" integer NOT NULL,
  "created_by" text NOT NULL,
  "proposal" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "deck_project_version_unique" ON "deck_versions" ("project_id", "version");
