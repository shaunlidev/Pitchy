import { topicTaskSelectionSchema, topicRefSchema, topicMaterialSchema } from "@pitchroom/domain";
import { briefWorkspaceSchema, saveBriefSchema } from "@pitchroom/domain";
import { z } from "zod";
import { positioningHeadSchema, positioningWordingInputSchema, clarificationTaskSchema, clarificationResultSchema, acceptedMediaTypes, storyHeadSchema, storyRequestSchema, storyWorkspaceSchema, deckProposalSchema, positioningProposalV1Schema, sourceChunkSchema, understandingProposalV1Schema } from "@pitchroom/domain";

const commandId = z.string().trim().min(1).max(200).optional();
const expectedRevision = z.number().int().nonnegative();

export const workspaceCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("attach_topic_material"), commandId: z.string().min(1), topic: topicRefSchema, name: z.string().trim().min(1).max(255), mediaType: z.enum(acceptedMediaTypes), text: z.string().min(1).max(1_048_576) }),
  z.object({ action: z.literal("link_topic_material"), commandId: z.string().min(1), topic: topicRefSchema, sourceId: z.string().min(1) }),
  z.object({ action: z.literal("unlink_topic_material"), commandId: z.string().min(1), topic: topicRefSchema, sourceId: z.string().min(1) }),
  saveBriefSchema.extend({ action: z.literal("save_brief") }),
  z.object({ action:z.literal("propose_story"), commandId:z.string().min(1), expected:storyHeadSchema, request:storyRequestSchema, retryOf:z.string().optional() }),
  z.object({ action:z.literal("decide_story"), commandId:z.string().min(1), expected:storyHeadSchema, proposalId:z.string(), decision:z.enum(["apply","keep_current"]) }),
  z.object({ action:z.literal("undo_story"), commandId:z.string().min(1), expected:storyHeadSchema }),
  z.object({ action:z.literal("create_story_deck"), commandId:z.string().min(1), expected:storyHeadSchema }),
  z.object({ action: z.literal("submit_clarification"), commandId: z.string().min(1), expectedRevision, text: z.string().trim().min(1).max(10000), selection: topicTaskSelectionSchema.optional(), rebaseTaskId: z.string().optional() }),
  z.object({ action: z.literal("apply_clarification"), commandId: z.string().min(1), taskId: z.string(), result: clarificationResultSchema.optional() }),
  z.object({ action: z.literal("dismiss_clarification"), commandId: z.string().min(1), taskId: z.string() }),
  z.object({ action: z.literal("retry_clarification"), commandId: z.string().min(1), taskId: z.string() }),
  z.object({ action: z.literal("reset"), commandId }),
  z.object({
    action: z.literal("add_material"),
    commandId,
    name: z.string().trim().min(1).max(255),
    mediaType: z.enum(acceptedMediaTypes),
    text: z.string().min(1).max(1_048_576),
  }),
  z.object({ action: z.literal("run"), commandId }),
  z.object({ action: z.literal("remove_material"), commandId, sourceId: z.string().min(1) }),
  z.object({ action: z.literal("correct"), commandId, expectedRevision, themeIndex: z.number().int().nonnegative(), claimIndex: z.number().int().nonnegative(), text: z.string().trim().min(1).max(10_000) }),
  z.object({ action: z.literal("answer"), commandId, expectedRevision, text: z.string().trim().min(1).max(10_000) }),
  z.object({ action: z.literal("keep_unknown"), commandId, expectedRevision }),
  z.object({ action: z.literal("accept"), commandId, expectedRevision }),
  z.object({ action: z.literal("generate_positioning"), commandId, expectedRevision, expectedPositioning: positioningHeadSchema }),
  z.object({ action: z.literal("apply_positioning"), commandId, expectedRevision, expectedPositioning: positioningHeadSchema, directionId: z.string().min(1) }),
  z.object({ action: z.literal("undo_positioning"), commandId, expectedRevision, expectedPositioning: positioningHeadSchema }),
  z.object({ action: z.literal("adjust_positioning"), commandId, expectedRevision, expectedPositioning: positioningHeadSchema, directionId: z.string().min(1), mode: z.enum(["headline", "judgment_note"]), text: z.string().min(1).max(10_000).refine(value=>Boolean(value.trim())) }),
  z.object({ action: z.literal("save_positioning_wording"), commandId, expectedRevision, expectedPositioning: positioningHeadSchema, wording: positioningWordingInputSchema }),
  z.object({ action: z.literal("generate_deck"), commandId, expectedRevision, expectedPositioning:positioningHeadSchema }),
  z.object({ action: z.literal("edit_deck_page"), commandId, deckId: z.string().min(1), expectedDeckVersion: z.number().int().positive(), pageId: z.string().min(1), title: z.string().min(1).max(500), body: z.string().min(1).max(20_000) }),
]);

const materialSchema = z.object({
  kind: z.enum(["file", "brief"]).default("file"),
  sourceId: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.enum(acceptedMediaTypes),
  content: z.string(),
  contentHash: z.string().min(1),
  chunks: z.array(sourceChunkSchema.extend({ ordinal: z.number().int().nonnegative() })),
  agentReview: z.object({
    status: z.literal("quarantined"),
    affectedChunks: z.number().int().positive(),
    message: z.string().min(1),
  }).optional(),
});

const versionSchema = z.object({
  parentUnderstandingId: z.string().optional(),
  clarificationTaskId: z.string().optional(),
  id: z.string().min(1),
  number: z.number().int().positive(),
  proposal: understandingProposalV1Schema,
  createdBy: z.enum(["agent", "user"]),
  createdAt: z.string().datetime(),
});

const positioningVersionSchema = z.object({
  head:positioningHeadSchema.optional(),
  id: z.string().min(1),
  number: z.number().int().positive(),
  proposal: positioningProposalV1Schema,
  appliedDirectionId: z.string().min(1).optional(),
  previousAppliedDirectionId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
});

export const workspaceStateSchema = z.object({
  mode: z.enum(["synthetic-fixture", "postgres-fake", "live"]),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    phase: z.enum(["empty", "materials_ready", "reading", "structuring", "review_required", "accepted", "failed", "cancelled"]),
    revision: z.number().int().nonnegative(),
  }),
  sources: z.array(materialSchema),
  topicMaterials: z.array(topicMaterialSchema).default([]),
  removedSources: z.array(materialSchema).default([]),
  brief: briefWorkspaceSchema.default({ head: null, versions: [] }),
  versions: z.array(versionSchema),
  currentVersionId: z.string().min(1).optional(),
  positioning: positioningVersionSchema.optional(),
  positioningVersions: z.array(positioningVersionSchema),
  deck: z.object({ id: z.string().min(1), number: z.number().int().positive(), proposal: deckProposalSchema, createdBy: z.enum(["agent", "user"]), createdAt: z.string().datetime(), stale: z.boolean() }).optional(),
  deckVersions: z.array(z.object({ id: z.string().min(1), number: z.number().int().positive(), proposal: deckProposalSchema, createdBy: z.enum(["agent", "user"]), createdAt: z.string().datetime() })),
  clarifications: z.array(clarificationTaskSchema).optional(),
  story: storyWorkspaceSchema.optional(),
  workflowRuns: z.array(z.object({ id: z.string().min(1), kind: z.enum(["positioning", "deck", "story"]), status: z.enum(["running", "completed", "failed"]), failureMessage: z.string().optional(), events: z.array(z.object({ type: z.string(), detail: z.string(), at: z.string() })) })),
  events: z.array(z.object({ sequence: z.number().int().positive(), label: z.string().min(1), detail: z.string(), at: z.string().datetime() })),
});

export const workspaceEventSchema = workspaceStateSchema.shape.events.element;

export const errorEnvelopeSchema = z.object({
  code: z.string().min(1),
  error: z.string().min(1),
  requestId: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
