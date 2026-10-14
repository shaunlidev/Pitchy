ALTER TABLE "understanding_versions" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "understanding_versions" ADD COLUMN "user_input_id" uuid;--> statement-breakpoint
ALTER TABLE "understanding_versions" ADD COLUMN "created_by" text;--> statement-breakpoint
UPDATE "understanding_versions" SET "created_by" = 'agent' WHERE "created_by" IS NULL;--> statement-breakpoint
ALTER TABLE "understanding_versions" ALTER COLUMN "created_by" SET NOT NULL;
