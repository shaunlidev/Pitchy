ALTER TABLE projects ADD COLUMN current_story_id uuid;
ALTER TABLE projects ADD COLUMN story_generation integer NOT NULL DEFAULT 0;
ALTER TABLE deck_versions ADD COLUMN story_id uuid;
CREATE TABLE story_proposals (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), command_id text NOT NULL,
 request_hash text NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX story_project_command_unique ON story_proposals(project_id, command_id);
CREATE TABLE story_versions (
 id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
