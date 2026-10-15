import type { PositioningProposalV1, UnderstandingProposalV1 } from "@pitchroom/domain";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const projectPhase = pgEnum("project_phase", [
  "empty",
  "materials_ready",
  "reading",
  "structuring",
  "review_required",
  "accepted",
  "failed",
  "cancelled",
]);

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  phase: projectPhase("phase").notNull().default("empty"),
  version: integer("version").notNull().default(0),
  currentUnderstandingId: uuid("current_understanding_id"),
  currentPositioningId: uuid("current_positioning_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const commandReceipts = pgTable(
  "command_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    commandType: text("command_type").notNull(),
    requestHash: text("request_hash").notNull(),
    resourceId: text("resource_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("command_receipts_project_key_unique").on(table.projectId, table.idempotencyKey)],
);

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mediaType: text("media_type").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("sources_project_hash_unique").on(
      table.projectId,
      table.contentHash,
    ),
    uniqueIndex("sources_project_idempotency_unique").on(table.projectId, table.idempotencyKey),
  ],
);

export const sourceChunks = pgTable(
  "source_chunks",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    text: text("text").notNull(),
  },
  (table) => [
    uniqueIndex("source_chunks_source_ordinal_unique").on(
      table.sourceId,
      table.ordinal,
    ),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    stepCount: integer("step_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_runs_project_started_idx").on(table.projectId, table.startedAt),
    uniqueIndex("agent_runs_project_idempotency_unique").on(table.projectId, table.idempotencyKey),
  ],
);

export const agentEvents = pgTable(
  "agent_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("agent_events_run_sequence_unique").on(table.runId, table.sequence)],
);

export const understandingVersions = pgTable(
  "understanding_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "restrict" }),
    userInputId: uuid("user_input_id"),
    createdBy: text("created_by").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    proposal: jsonb("proposal").$type<UnderstandingProposalV1>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("understanding_project_version_unique").on(
      table.projectId,
      table.version,
    ),
  ],
);

export const userInputs = pgTable(
  "user_inputs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    actorId: text("actor_id").notNull(),
    targetVersion: integer("target_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("user_inputs_project_idempotency_unique").on(table.projectId, table.idempotencyKey)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    understandingId: uuid("understanding_id")
      .notNull()
      .references(() => understandingVersions.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("approvals_project_created_idx").on(table.projectId, table.createdAt),
    uniqueIndex("approvals_project_idempotency_unique").on(table.projectId, table.idempotencyKey),
  ],
);

export const positioningVersions = pgTable(
  "positioning_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    understandingId: uuid("understanding_id").notNull().references(() => understandingVersions.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    proposal: jsonb("proposal").$type<PositioningProposalV1>().notNull(),
    appliedDirectionId: text("applied_direction_id"),
    previousAppliedDirectionId: text("previous_applied_direction_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("positioning_project_version_unique").on(table.projectId, table.version)],
);
