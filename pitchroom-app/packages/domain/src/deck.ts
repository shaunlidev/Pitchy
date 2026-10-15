import { z } from "zod";
import { ProposalEvidenceError, type SourceChunk } from "./understanding";
import { positioningEvidenceSchema } from "./positioning";

export const deckPageKinds = ["positioning", "shift", "rationale", "evidence", "open_questions"] as const;

export const deckPageSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(deckPageKinds),
  title: z.string().min(1),
  body: z.string().min(1),
  evidence: z.array(positioningEvidenceSchema),
  userInputIds: z.array(z.string().min(1)).default([]),
  openQuestions: z.array(z.string().min(1)).default([]),
});

export const deckProposalV1Schema = z.object({
  schemaVersion: z.literal(1),
  understandingVersionId: z.string().min(1),
  positioningVersionId: z.string().min(1),
  appliedDirectionId: z.string().min(1),
  pages: z.array(deckPageSchema).length(5),
}).superRefine((proposal, context) => {
  deckPageKinds.forEach((kind, index) => {
    if (proposal.pages[index]?.kind !== kind) context.addIssue({ code: "custom", path: ["pages", index, "kind"], message: `Page ${index + 1} must be ${kind}.` });
  });
  if (proposal.pages[3]?.evidence.length === 0) context.addIssue({ code: "custom", path: ["pages", 3, "evidence"], message: "The evidence page requires source evidence." });
});

export type DeckProposalV1 = z.infer<typeof deckProposalV1Schema>;

export function validateDeckEvidence(proposal: DeckProposalV1, chunks: readonly SourceChunk[]) {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const page of proposal.pages) for (const evidence of page.evidence) {
    const chunk = chunksById.get(evidence.chunkId);
    if (!chunk) throw new ProposalEvidenceError(`Deck references missing chunk: ${evidence.chunkId}`);
    if (chunk.sourceId !== evidence.sourceId) throw new ProposalEvidenceError(`Chunk ${evidence.chunkId} does not belong to source ${evidence.sourceId}`);
    if (!chunk.text.includes(evidence.quote)) throw new ProposalEvidenceError(`Deck quote is not present in chunk ${evidence.chunkId}`);
  }
}
