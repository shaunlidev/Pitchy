import { z } from "zod";
import { ProposalEvidenceError, type SourceChunk } from "./understanding";
import { positioningEvidenceSchema } from "./positioning";

export const deckPageKinds = ["positioning", "shift", "rationale", "evidence", "open_questions"] as const;

export const deckPageSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(deckPageKinds),
  title: z.string().min(1),
  body: z.string().min(1),
  speakerNotes: z.string().optional(),
  evidence: z.array(positioningEvidenceSchema),
  userInputIds: z.array(z.string().min(1)).default([]),
  openQuestions: z.array(z.string().min(1)).default([]),
});

export const deckProposalV1Schema = z.object({
  schemaVersion: z.literal(1),
  understandingVersionId: z.string().min(1),
  positioningVersionId: z.string().min(1),
  positioningDecisionId:z.string().min(1).optional(),
  appliedDirectionId: z.string().min(1),
  pages: z.array(deckPageSchema).length(5),
}).superRefine((proposal, context) => {
  deckPageKinds.forEach((kind, index) => {
    if (proposal.pages[index]?.kind !== kind) context.addIssue({ code: "custom", path: ["pages", index, "kind"], message: `Page ${index + 1} must be ${kind}.` });
  });
  if (proposal.pages[3]?.evidence.length === 0) context.addIssue({ code: "custom", path: ["pages", 3, "evidence"], message: "The evidence page requires source evidence." });
});

export type DeckProposalV1 = z.infer<typeof deckProposalV1Schema>;

export const deckPageV2Schema = deckPageSchema.extend({
  kind: z.enum(["promise", "situation", "mechanism", "rationale", "evidence", "open_questions"]),
  storyBlockId: z.string().min(1), emphasis: z.array(z.string()), basisRefs: z.array(z.string()), unknownIds: z.array(z.string()),
  wording: z.enum(["agent_proposed", "user_edited_unreviewed"]),
});
export const deckProposalV2Schema = z.object({ schemaVersion: z.literal(2), understandingVersionId: z.string().min(1), positioningVersionId: z.string().min(1), positioningDecisionId:z.string().min(1).optional(), appliedDirectionId: z.string().min(1), storyVersionId: z.string().min(1), storyGeneration: z.number().int(), pages: z.array(deckPageV2Schema).min(3).max(8) });
export const deckProposalSchema = z.union([deckProposalV1Schema, deckProposalV2Schema]);
export type DeckProposal = z.infer<typeof deckProposalSchema>;
export function storyToDeck(input: { storyId: string; generation: number; story: import("./story").Story }): z.infer<typeof deckProposalV2Schema> {
  const { story } = input;
  return deckProposalV2Schema.parse({ schemaVersion: 2, ...story.origin, appliedDirectionId: story.origin.directionId, storyVersionId: input.storyId, storyGeneration: input.generation, pages: story.blocks.map(block => ({
    id: `page-${block.id}`, kind: block.role, title: block.title, body: block.body, storyBlockId: block.id, emphasis: block.emphasis, basisRefs: block.basisRefs, unknownIds: block.unknownIds, wording: block.wording,
    speakerNotes: `${story.strategicRationale.choice}\n${story.strategicRationale.tradeoff}\n${story.strategicRationale.conditionsToReconsider.join("\n")}`,
    evidence: story.bases.flatMap(b => b.kind === "source_excerpt" && block.basisRefs.includes(b.id) ? [{ sourceId: b.sourceId, chunkId: b.chunkId, quote: b.quote }] : []),
    userInputIds: story.bases.flatMap(b => b.kind === "consultant_judgment" && block.basisRefs.includes(b.id) ? [b.userInputId] : []),
    openQuestions: story.unknowns.filter(u => block.unknownIds.includes(u.id)).map(u => u.text),
  })) });
}

export function validateDeckEvidence(proposal: DeckProposalV1, chunks: readonly SourceChunk[]) {
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  for (const page of proposal.pages) for (const evidence of page.evidence) {
    const chunk = chunksById.get(evidence.chunkId);
    if (!chunk) throw new ProposalEvidenceError(`Deck references missing chunk: ${evidence.chunkId}`);
    if (chunk.sourceId !== evidence.sourceId) throw new ProposalEvidenceError(`Chunk ${evidence.chunkId} does not belong to source ${evidence.sourceId}`);
    if (!chunk.text.includes(evidence.quote)) throw new ProposalEvidenceError(`Deck quote is not present in chunk ${evidence.chunkId}`);
  }
}
