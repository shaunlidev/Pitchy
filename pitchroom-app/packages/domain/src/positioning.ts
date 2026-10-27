import { z } from "zod";
import type { SourceChunk } from "./understanding";
import { PitchroomError } from "./errors";
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

const id = z.string().min(1);
const exactText = z.string().min(1).max(10000).refine(value => Boolean(value.trim()), "Wording cannot be blank.");
export const positioningWordingInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source_quote"), sourceId: id, chunkId: id, start: z.number().int().nonnegative(), end: z.number().int().positive(), text: exactText }).strict(),
  z.object({ kind: z.literal("manual_exact"), text: exactText }).strict(),
]);
export type PositioningWordingInput = z.infer<typeof positioningWordingInputSchema>;
const retainedChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source_quote"), id, text: exactText, projectId: id, sourceId: id, sourceName: id, sourceHash: id, chunkId: id, start: z.number().int().nonnegative(), end: z.number().int().positive(), userInputId: id }),
  z.object({ kind: z.literal("manual_exact"), id, text: exactText, userInputId: id }),
]);
const choiceSchema = z.discriminatedUnion("kind", [
  ...retainedChoiceSchema.options,
  z.object({ kind: z.literal("accepted_understanding"), id: z.literal("original"), text: id, understandingId: id }),
  z.object({ kind: z.literal("legacy_wording"), id: z.literal("original"), text: id }),
  z.object({ kind: z.literal("ai_direction"), id, text: id, direction: positioningDirectionSchema }),
]);
const choiceSnapshotSchema = z.object({ positioningId: id, choice: choiceSchema });
const decisionSchema = z.object({ id, commandId: id, action: z.enum(["apply", "undo"]), before: choiceSnapshotSchema.nullable(), after: choiceSnapshotSchema.nullable() });
export const positioningHeadSchema = z.object({ positioningId: id.nullable(), decisionId: id.nullable() }).strict();
export type PositioningHead = z.infer<typeof positioningHeadSchema>;
export type PositioningChoice = z.infer<typeof choiceSchema>;
export type RetainedPositioningChoice = z.infer<typeof retainedChoiceSchema>;

export const positioningProposalV1Schema = z.object({
  schemaVersion: z.literal(1),
  understandingVersionId: z.string().min(1),
  originalFraming: z.object({
    title: z.literal("Original framing"),
    coreMessage: z.string().min(1),
    origin: z.literal("accepted_understanding").optional(),
  }),
  retainedChoices: z.array(retainedChoiceSchema).optional(),
  decisionJournal: z.array(decisionSchema).optional(),
  directions: z.array(positioningDirectionSchema).min(2).max(3),
  recommendation: z.object({
    directionId: z.string().min(1),
    judgment: z.string().min(1),
    comparison: z.string().min(1),
    conditionsToReconsider: z.array(z.string().min(1)),
  }).optional(),
}).superRefine((proposal, context) => {
  const ids = ["original", ...proposal.directions.map(item => item.id), ...(proposal.retainedChoices ?? []).map(item => item.id)];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Positioning choice IDs must be unique." });
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

export type PositioningRecord = { id: string; proposal: PositioningProposalV1; appliedDirectionId?: string | null; previousAppliedDirectionId?: string | null };
export function positioningChoices(proposal: PositioningProposalV1): PositioningChoice[] {
  const original: PositioningChoice = proposal.originalFraming.origin === "accepted_understanding"
    ? { kind: "accepted_understanding", id: "original", text: proposal.originalFraming.coreMessage, understandingId: proposal.understandingVersionId }
    : { kind: "legacy_wording", id: "original", text: proposal.originalFraming.coreMessage };
  return [original, ...proposal.directions.map((direction): PositioningChoice => ({ kind: "ai_direction", id: direction.id, text: direction.coreMessage, direction })), ...(proposal.retainedChoices ?? [])];
}
export function resolvePositioningChoice(proposal: PositioningProposalV1, choiceId: string): PositioningChoice {
  const choice = positioningChoices(proposal).find(item => item.id === choiceId);
  if (!choice) throw new PitchroomError("INVALID_INPUT", "The selected positioning choice does not exist.");
  return choice;
}
export function positioningChoiceLabel(choice: PositioningChoice): string {
  switch (choice.kind) {
    case "accepted_understanding": return "Accepted interpretation";
    case "legacy_wording": return "Saved framing · origin unrecorded";
    case "source_quote": return "Original wording · selected source quote";
    case "manual_exact": return "Your exact wording · unverified";
    case "ai_direction": return choice.direction.title;
  }
}
export function readPositioning(record: PositioningRecord) {
  const last = record.proposal.decisionJournal?.at(-1);
  const legacy = !last && record.appliedDirectionId ? { positioningId: record.id, choice: resolvePositioningChoice(record.proposal, record.appliedDirectionId) } : null;
  const snapshot = last ? last.after : legacy;
  return { head: { positioningId: record.id, decisionId: last?.id ?? null } satisfies PositioningHead,
    choices: positioningChoices(record.proposal),
    applied: snapshot ? { ...snapshot, decisionId: last?.id ?? null } : null,
    canUndo: last ? last.action === "apply" : Boolean(record.appliedDirectionId),
  };
}
export function assertPositioningHead(record: PositioningRecord | undefined, expected: PositioningHead) {
  const actual = record ? readPositioning(record).head : { positioningId: null, decisionId: null };
  if (actual.positioningId !== expected.positioningId || actual.decisionId !== expected.decisionId)
    throw new PitchroomError("CONFLICT", "This positioning choice changed. Refresh before continuing; your wording is retained.");
}
export function changePositioningChoice(record: PositioningRecord, operation: { kind: "apply"; choiceId: string } | { kind: "undo" }, commandId: string, decisionId: string) {
  const view = readPositioning(record);
  const prior = record.proposal.decisionJournal?.at(-1);
  if (operation.kind === "undo" && !view.canUndo) throw new PitchroomError("CONFLICT", "There is no positioning decision to undo.");
  const before = view.applied ? { positioningId: view.applied.positioningId, choice: structuredClone(view.applied.choice) } : null;
  const after = operation.kind === "apply" ? { positioningId: record.id, choice: structuredClone(resolvePositioningChoice(record.proposal, operation.choiceId)) }
    : prior ? prior.before : record.previousAppliedDirectionId ? { positioningId: record.id, choice: structuredClone(resolvePositioningChoice(record.proposal, record.previousAppliedDirectionId)) } : null;
  const proposal = structuredClone(record.proposal);
  proposal.decisionJournal = [...(proposal.decisionJournal ?? []), { id: decisionId, commandId, action: operation.kind, before, after }];
  return { proposal: positioningProposalV1Schema.parse(proposal), appliedDirectionId: after?.choice.id ?? null,
    previousAppliedDirectionId: operation.kind === "apply" ? before?.choice.id ?? null : null };
}
export function positioningDecisionResult(record: PositioningRecord, decisionId: string) {
  const index = record.proposal.decisionJournal?.findIndex(item => item.id === decisionId) ?? -1;
  if (index < 0) throw new PitchroomError("PERSISTENCE_ERROR", "The saved positioning decision was not found.");
  const proposal = structuredClone(record.proposal); proposal.decisionJournal = proposal.decisionJournal!.slice(0, index + 1);
  const decision = proposal.decisionJournal.at(-1)!;
  return { ...record, proposal, appliedDirectionId: decision.after?.choice.id ?? null, previousAppliedDirectionId: decision.action === "apply" ? decision.before?.choice.id ?? null : null };
}
export function samePositioningChoice(left: PositioningChoice | undefined, right: PositioningChoice | undefined) {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}
export function validateRetainedPositioningChoice(choice: RetainedPositioningChoice, projectId: string, sources: readonly { id: string; name: string; contentHash: string; chunks: readonly SourceChunk[] }[]) {
  if (choice.kind !== "source_quote") return;
  const source = sources.find(item => item.id === choice.sourceId);
  const chunk = source?.chunks.find(item => item.id === choice.chunkId);
  if (choice.projectId !== projectId || !source || source.contentHash !== choice.sourceHash || !chunk || chunk.sourceId !== choice.sourceId || choice.end <= choice.start || chunk.text.slice(choice.start, choice.end) !== choice.text)
    throw new PitchroomError("CONFLICT", "The selected source wording is unavailable or changed. Choose a current exact passage; the saved wording remains in history.");
}
