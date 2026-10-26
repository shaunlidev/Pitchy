CREATE TYPE "public"."source_kind" AS ENUM('file', 'brief');--> statement-breakpoint
CREATE TABLE "brief_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "source_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DROP INDEX "sources_project_hash_unique";--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "kind" "source_kind" DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "brief_versions" ADD CONSTRAINT "brief_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_versions" ADD CONSTRAINT "brief_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brief_versions_project_version_unique" ON "brief_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_project_kind_hash_unique" ON "sources" USING btree ("project_id","kind","content_hash");
