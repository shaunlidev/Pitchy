import { z } from "zod";
import type { SourceChunk } from "./understanding";
import { ProposalEvidenceError } from "./understanding";

export const positioningEvidenceSchema = z.object({
  sourceId: z.string().min(1),
  chunkId: z.string().min(1),
  quote: z.string().min(1),
});

export const positioningDirectionSchema = z.object({
  id: z.string().min(1),
  lens: z.enum(["mechanism", "human_tension"]).optional(),
  title: z.string().min(1),
  audience: z.string().min(1).optional(),
  positioningThesis: z.string().min(1).optional(),
  mechanism: z.string().min(1).optional(),
  humanTension: z.string().min(1).optional(),
  coreMessage: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  tradeoff: z.string().min(1),
  excludes: z.array(z.string().min(1)),
  evidence: z.array(positioningEvidenceSchema).min(1),
  userInputIds: z.array(z.string().min(1)).default([]),
  judgmentNote: z.string().min(1).optional(),
  counterEvidence: z.array(positioningEvidenceSchema).optional(),
  unknowns: z.array(z.string().min(1)).optional(),
  emphasis: z.array(z.string().min(1)).optional(),
  audienceRecognition: z.string().min(1).optional(),
  humanPayoff: z.string().min(1).optional(),
});

export const positioningProposalV1Schema = z.object({
  schemaVersion: z.literal(1),
  understandingVersionId: z.string().min(1),
  originalFraming: z.object({
    title: z.literal("Original framing"),
    coreMessage: z.string().min(1),
  }),
  directions: z.array(positioningDirectionSchema).min(2).max(3),
  recommendation: z.object({
    directionId: z.string().min(1),
    judgment: z.string().min(1),
    comparison: z.string().min(1),
    conditionsToReconsider: z.array(z.string().min(1)),
  }).optional(),
}).superRefine((proposal, context) => {
  if (proposal.recommendation && !proposal.directions.some((direction) => direction.id === proposal.recommendation?.directionId)) {
    context.addIssue({ code: "custom", path: ["recommendation", "directionId"], message: "Recommended direction must exist in the proposal." });
  }
});

export type PositioningProposalV1 = z.infer<typeof positioningProposalV1Schema>;

export function validatePositioningEvidence(proposal: PositioningProposalV1, chunks: readonly SourceChunk[]) {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const direction of proposal.directions) {
    for (const evidence of direction.evidence) {
      const chunk = chunksById.get(evidence.chunkId);
      if (!chunk) throw new ProposalEvidenceError(`Positioning references missing chunk: ${evidence.chunkId}`);
      if (chunk.sourceId !== evidence.sourceId) throw new ProposalEvidenceError(`Chunk ${evidence.chunkId} does not belong to source ${evidence.sourceId}`);
      if (!chunk.text.includes(evidence.quote)) throw new ProposalEvidenceError(`Positioning quote is not present in chunk ${evidence.chunkId}`);
    }
  }
}
