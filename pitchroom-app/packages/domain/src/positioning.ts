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
  title: z.string().min(1),
  coreMessage: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  tradeoff: z.string().min(1),
  excludes: z.array(z.string().min(1)),
  evidence: z.array(positioningEvidenceSchema).min(1),
  userInputIds: z.array(z.string().min(1)).default([]),
  judgmentNote: z.string().min(1).optional(),
});

export const positioningProposalV1Schema = z.object({
  schemaVersion: z.literal(1),
  understandingVersionId: z.string().min(1),
  originalFraming: z.object({
    title: z.literal("Original framing"),
    coreMessage: z.string().min(1),
  }),
  directions: z.array(positioningDirectionSchema).min(2).max(3),
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
