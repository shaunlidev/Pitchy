ALTER TABLE "projects" ADD COLUMN "current_positioning_id" uuid;
CREATE TABLE "positioning_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "understanding_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "proposal" jsonb NOT NULL,
  "applied_direction_id" text,
  "previous_applied_direction_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "positioning_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade,
  CONSTRAINT "positioning_versions_understanding_id_understanding_versions_id_fk" FOREIGN KEY ("understanding_id") REFERENCES "public"."understanding_versions"("id") ON DELETE restrict
);
CREATE UNIQUE INDEX "positioning_project_version_unique" ON "positioning_versions" USING btree ("project_id", "version");
