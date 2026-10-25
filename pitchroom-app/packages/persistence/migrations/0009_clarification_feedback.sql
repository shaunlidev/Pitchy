CREATE TABLE "clarification_tasks" (
  "id" uuid PRIMARY KEY NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id"),
  "command_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "clarification_project_command_unique" ON "clarification_tasks" ("project_id", "command_id");
CREATE UNIQUE INDEX "clarification_one_pending" ON "clarification_tasks" ("project_id") WHERE payload->>'status' IN ('queued','running','proposal_ready','no_change','failed');

ALTER TABLE "understanding_versions" ADD COLUMN "parent_understanding_id" uuid REFERENCES "understanding_versions"("id");
ALTER TABLE "understanding_versions" ADD COLUMN "clarification_task_id" uuid REFERENCES "clarification_tasks"("id");
