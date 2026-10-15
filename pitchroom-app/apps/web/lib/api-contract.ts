import { z } from "zod";
import { acceptedMediaTypes, positioningProposalV1Schema, sourceChunkSchema, understandingProposalV1Schema } from "@pitchroom/domain";

const commandId = z.string().trim().min(1).max(200).optional();
const expectedRevision = z.number().int().nonnegative();

export const workspaceCommandSchema = z.discriminatedUnion("action", [
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
  z.object({ action: z.literal("generate_positioning"), commandId, expectedRevision }),
  z.object({ action: z.literal("apply_positioning"), commandId, expectedRevision, directionId: z.string().min(1) }),
  z.object({ action: z.literal("undo_positioning"), commandId, expectedRevision }),
]);

const materialSchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1),
  mediaType: z.enum(acceptedMediaTypes),
  content: z.string(),
  contentHash: z.string().min(1),
  chunks: z.array(sourceChunkSchema.extend({ ordinal: z.number().int().nonnegative() })),
});

const versionSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  proposal: understandingProposalV1Schema,
  createdBy: z.enum(["agent", "user"]),
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
  versions: z.array(versionSchema),
  currentVersionId: z.string().min(1).optional(),
  positioning: z.object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    proposal: positioningProposalV1Schema,
    appliedDirectionId: z.string().min(1).optional(),
    previousAppliedDirectionId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  }).optional(),
  events: z.array(z.object({ sequence: z.number().int().positive(), label: z.string().min(1), detail: z.string(), at: z.string().datetime() })),
});

export const workspaceEventSchema = workspaceStateSchema.shape.events.element;

export const errorEnvelopeSchema = z.object({
  code: z.string().min(1),
  error: z.string().min(1),
  requestId: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
