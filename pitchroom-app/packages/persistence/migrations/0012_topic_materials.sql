CREATE TABLE "topic_materials" (
 "project_id" uuid NOT NULL CONSTRAINT "topic_materials_project_id_projects_id_fk" REFERENCES "projects"("id"),
 "source_id" text NOT NULL CONSTRAINT "topic_materials_source_id_sources_id_fk" REFERENCES "sources"("id"),
 "understanding_id" uuid NOT NULL CONSTRAINT "topic_materials_understanding_id_understanding_versions_id_fk" REFERENCES "understanding_versions"("id"),
 "topic_kind" text NOT NULL CHECK ("topic_kind" IN ('theme', 'gap')),
 "topic_index" integer NOT NULL CHECK ("topic_index" >= 0),
 "label" text NOT NULL
);
CREATE UNIQUE INDEX "topic_materials_unique" ON "topic_materials" ("project_id", "source_id", "understanding_id", "topic_kind", "topic_index");
