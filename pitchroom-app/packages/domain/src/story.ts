import { z } from "zod";
import { PitchroomError } from "./errors";
import { understandingProposalV1Schema } from "./understanding";
import { positioningChoiceSchema, readPositioning, positioningHumanWording, samePositioningChoice, resolvePositioningChoice, positioningProposalV1Schema } from "./positioning";
import { sourceFingerprint } from "./clarification";

const text = z.string().min(1);
export const storyHeadSchema = z.object({ generation: z.number().int().nonnegative(), storyId: text.nullable() });
export const storyOriginSchema = z.object({ understandingVersionId: text, positioningVersionId: text, positioningDecisionId:text.optional(), sourceFingerprint: z.string(), directionId: text });
export const storyBasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("understanding_basis"), id: text, understandingBasisId: text }).strict(),
  z.object({ kind: z.literal("source_excerpt"), id: text, sourceId: text, chunkId: text, quote: text, statement: text, nature: z.enum(["record", "suggestion", "uncertain"]) }).strict(),
  z.object({ kind: z.literal("consultant_judgment"), id: text, userInputId: text, statement: text }).strict(),
  z.object({ kind: z.literal("agent_interpretation"), id: text, statement: text, supportingBasisRefs: z.array(text) }).strict(),
]);
export const storyBlockSchema = z.object({ id: text, role: z.enum(["promise", "situation", "mechanism", "rationale", "evidence", "open_questions"]), title: text, body: text, emphasis: z.array(text), basisRefs: z.array(text), unknownIds: z.array(text), wording: z.enum(["agent_proposed", "user_edited_unreviewed"]).default("agent_proposed") }).strict();
const storyUnknownSchema = z.object({ id: text, text }).strict();
export const storyContentSchema = z.object({
  audience: text, coreMessage: text,
  strategicRationale: z.object({ choice: text, tradeoff: text, exclusions: z.array(text), conditionsToReconsider: z.array(text), basisRefs: z.array(text) }).strict(),
  bases: z.array(storyBasisSchema).max(30), unknowns: z.array(storyUnknownSchema).max(30), blocks: z.array(storyBlockSchema).min(3).max(8),
}).strict();
const persistedStoryContentSchema = storyContentSchema.extend({
  bases: z.array(storyBasisSchema).refine(bases => bases.filter(basis => basis.kind !== "consultant_judgment").length <= 30, "A story may contain at most 30 non-consultant bases."),
  unknowns: z.array(storyUnknownSchema),
});
export const storySchema = persistedStoryContentSchema.extend({ schemaVersion: z.literal(1), origin: storyOriginSchema });
export const storyRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("develop_direction") }).strict(),
  z.object({ kind: z.literal("revise_story"), judgment: text.max(10000) }).strict(),
  z.object({ kind: z.literal("exact_edit"), blockId: text, title: text.max(500), body: text.max(20000) }).strict(),
  z.object({ kind: z.literal("restore"), storyId: text }).strict(),
]);
const sourceSchema = z.object({ id: text, projectId: text, name: text, mediaType: text, contentHash: text, chunks: z.array(z.object({ id: text, sourceId: text, text: z.string(), startOffset: z.number(), endOffset: z.number() })) });
export const storySnapshotSchema = z.object({ origin: storyOriginSchema, understanding: understandingProposalV1Schema, positioning: positioningProposalV1Schema, selectedChoice:positioningChoiceSchema.optional(), sources: z.array(sourceSchema), before: storySchema.nullable(), request: storyRequestSchema, userInput: z.object({ id: text, text }).nullable(), model: text, promptVersion: text });
export const storyDiffSchema = z.object({ fields: z.array(z.object({ field: text, before: z.string(), after: z.string() })), blocks: z.array(z.object({ id: text, kind: z.enum(["added", "removed", "changed", "moved"]), before: storyBlockSchema.nullable(), after: storyBlockSchema.nullable(), from: z.number().nullable(), to: z.number().nullable() })) });
const readySchema = z.object({ kind: z.literal("ready"), candidateId: text, candidate: storySchema, diff: storyDiffSchema, responseToJudgment: text });
const storyOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running"), attemptId:text, deadline:z.string() }), readySchema,
  z.object({kind:z.literal("failed"),explanation:text}), z.object({kind:z.literal("no_change"),explanation:text}),
  z.object({kind:z.literal("stale"),explanation:text,savedCandidate:storySchema.nullable()}),
]);
export const storyProposalSchema = z.object({ id: text, projectId: text, commandId: text, createdAt: z.string(), baseHead: storyHeadSchema, snapshot: storySnapshotSchema, savedResult: storyOutcomeSchema.optional(),
  state: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("running"), attemptId: text, deadline: z.string() }), readySchema,
    z.object({ kind: z.literal("failed"), explanation: text }), z.object({ kind: z.literal("no_change"), explanation: text }),
    z.object({ kind: z.literal("stale"), explanation: text, savedCandidate: storySchema.nullable() }),
    z.object({ kind: z.literal("applied"), storyId: text, generation: z.number(), commandId: text }),
    z.object({ kind: z.literal("kept"), commandId: text }),
  ]),
});
export const storyVersionSchema = z.object({ id: text, parentId: text.nullable(), proposalId: text, story: storySchema, snapshot: storySnapshotSchema, createdAt: z.string() });
export const storyWorkspaceSchema = z.object({ head: storyHeadSchema, versions: z.array(storyVersionSchema), proposals: z.array(storyProposalSchema), stale: z.boolean() });
export type Story = z.infer<typeof storySchema>;
export type StoryHead = z.infer<typeof storyHeadSchema>;
export type StorySnapshot = z.infer<typeof storySnapshotSchema>;
export type StoryRequest = z.infer<typeof storyRequestSchema>;
export type StoryProposal = z.infer<typeof storyProposalSchema>;
export type StoryVersion = z.infer<typeof storyVersionSchema>;
export type StoryWorkspace = z.infer<typeof storyWorkspaceSchema>;

export function compareStories(before: Story | null, after: Story): z.infer<typeof storyDiffSchema> {
  const fields = ["audience", "coreMessage", "strategicRationale", "bases", "unknowns"].flatMap(field => {
    const key = z.enum(["audience", "coreMessage", "strategicRationale", "bases", "unknowns"]).parse(field);
    const a = before ? JSON.stringify(before[key]) : "", b = JSON.stringify(after[key]);
    return a === b ? [] : [{ field, before: a, after: b }];
  });
  const blocks: z.infer<typeof storyDiffSchema>["blocks"] = [];
  for (const [to, block] of after.blocks.entries()) {
    const from = before?.blocks.findIndex(b => b.id === block.id) ?? -1;
    const prior = from < 0 ? undefined : before?.blocks[from];
    if (!prior) blocks.push({ id: block.id, kind: "added", before: null, after: block, from: null, to });
    else if (JSON.stringify(prior) !== JSON.stringify(block)) blocks.push({ id: block.id, kind: "changed", before: prior, after: block, from, to });
    else if (from !== to) blocks.push({ id: block.id, kind: "moved", before: prior, after: block, from, to });
  }
  before?.blocks.forEach((block, from) => { if (!after.blocks.some(b => b.id === block.id)) blocks.push({ id: block.id, kind: "removed", before: block, after: null, from, to: null }); });
  return { fields, blocks };
}
type PositioningOrigin = { positioningVersionId:string|null; positioningDecisionId?:string|null };
function samePositioningOrigin(a:PositioningOrigin,b:PositioningOrigin) {
  if(a.positioningDecisionId&&b.positioningDecisionId)return a.positioningDecisionId===b.positioningDecisionId;
  if([a.positioningDecisionId,b.positioningDecisionId].some(id=>id&&!id.startsWith("legacy:")))return false;
  return a.positioningVersionId===b.positioningVersionId;
}
export function storyIsFresh(origin: Story["origin"], current: { phase: string; understandingId: string | null; positioningId: string | null; directionId: string | null; positioningDecisionId?:string|null; sources: StorySnapshot["sources"] }) {
  return current.phase === "accepted" && origin.understandingVersionId === current.understandingId && samePositioningOrigin(origin,{positioningVersionId:current.positioningId,positioningDecisionId:current.positioningDecisionId}) && origin.directionId === current.directionId && origin.sourceFingerprint === sourceFingerprint(current.sources);
}
export function sameStoryOrigin(a: Story["origin"], b: Story["origin"]) { return a.understandingVersionId === b.understandingVersionId && samePositioningOrigin(a,b) && a.directionId === b.directionId && a.sourceFingerprint === b.sourceFingerprint; }
export function assertStoryHead(expected: StoryHead, actual: StoryHead) {
  if (expected.generation !== actual.generation || expected.storyId !== actual.storyId) throw new PitchroomError("CONFLICT", "The adopted story changed. Review the current story before continuing.");
}
export function understandingStoryUnknowns(snapshot: Pick<StorySnapshot, "origin" | "understanding">): Story["unknowns"] {
  return snapshot.understanding.gaps.map((gap, index) => ({ id: `understanding-gap:${snapshot.origin.understandingVersionId}:${index}`, text: gap.description }));
}
export function validateStory(raw: unknown, snapshot: StorySnapshot): Story {
  const story = storySchema.parse({ ...persistedStoryContentSchema.parse(raw), schemaVersion: 1, origin: snapshot.origin });
  const fail = (message: string): never => { throw new PitchroomError("PROPOSAL_REJECTED", message); };
  const requiredUnknowns = understandingStoryUnknowns(snapshot);
  if (snapshot.request.kind === "develop_direction") {
    const obsolete = new Set(story.unknowns.filter(u => u.id.startsWith("understanding-gap:") && !requiredUnknowns.some(required => required.id === u.id)).map(u => u.id));
    story.unknowns = story.unknowns.filter(u => !obsolete.has(u.id));
    story.blocks.forEach(block => { block.unknownIds = block.unknownIds.filter(id => !obsolete.has(id)); });
  }
  for (const unknown of requiredUnknowns) {
    const existing = story.unknowns.find(u => u.id === unknown.id);
    if (existing && existing.text !== unknown.text) fail("An Understanding gap cannot be rewritten by a story proposal.");
    if (!existing) story.unknowns.push(unknown);
    if (!story.blocks.some(block => block.unknownIds.includes(unknown.id))) {
      const block = story.blocks.find(block => block.role === "open_questions") ?? story.blocks.at(-1);
      block?.unknownIds.push(unknown.id);
    }
  }
  if (snapshot.request.kind === "revise_story" && snapshot.before && sameStoryOrigin(snapshot.before.origin, snapshot.origin) && snapshot.before.unknowns.some(u => !story.unknowns.some(next => next.id === u.id && next.text === u.text))) fail("A story judgment cannot silently remove or resolve saved unknowns.");
  const bases = new Map(story.bases.map(b => [b.id, b]));
  const unknowns = new Set(story.unknowns.map(u => u.id));
  if (bases.size !== story.bases.length || unknowns.size !== story.unknowns.length || new Set(story.blocks.map(b => b.id)).size !== story.blocks.length) fail("Story IDs must be unique.");
  const refs = (ids: string[]) => { if (new Set(ids).size !== ids.length || ids.some(id => !bases.has(id))) fail("Story has an unknown or duplicate basis reference."); };
  const understandingBases = snapshot.understanding.themes.flatMap(t => t.summaryInterpretation?.groundingV4?.bases ?? []);
  const selectedChoice=storySelectedChoice(snapshot);
  const humanWording=positioningHumanWording(selectedChoice);
  const inputs = new Set([...(humanWording?[humanWording.userInputId]:[]), ...(selectedChoice.kind==="source_quote"?[selectedChoice.userInputId]:[]), ...(snapshot.userInput ? [snapshot.userInput.id] : []), ...snapshot.understanding.themes.flatMap(t => t.claims.filter(c => !c.supersededBy).flatMap(c => c.userInputIds)), ...(snapshot.before?.bases.flatMap(b => b.kind === "consultant_judgment" ? [b.userInputId] : []) ?? [])]);
  for (const b of story.bases) {
    if (b.kind === "agent_interpretation" && b.supportingBasisRefs.length === 0) fail("Agent interpretations require attributed support.");
    if (b.kind === "source_excerpt") {
      const chunk = snapshot.sources.find(s => s.id === b.sourceId)?.chunks.find(c => c.id === b.chunkId);
      if (!chunk || !chunk.text.includes(b.quote)) fail("Story source quotation does not match the saved material.");
    } else if (b.kind === "understanding_basis" && !understandingBases.some(u => u.id === b.understandingBasisId)) fail("Story references an unknown Understanding basis.");
    else if (b.kind === "consultant_judgment" && !inputs.has(b.userInputId)) fail("Story references an unknown consultant input.");
    else if (b.kind === "agent_interpretation") refs(b.supportingBasisRefs);
  }
  const visit = (id: string, ancestors: Set<string>) => {
    if (ancestors.has(id)) fail("Story basis references contain a cycle.");
    const basis = bases.get(id);
    if (basis?.kind === "agent_interpretation") for (const ref of basis.supportingBasisRefs) visit(ref, new Set([...ancestors, id]));
  };
  story.bases.forEach(b => visit(b.id, new Set()));
  refs(story.strategicRationale.basisRefs);
  if (!story.strategicRationale.basisRefs.length || !story.blocks.some(block => block.basisRefs.length)) fail("Story rationale and narrative require traceable support.");
  if (!story.bases.some(b => b.kind === "source_excerpt" || (b.kind === "understanding_basis" && understandingBases.some(u => u.id === b.understandingBasisId && u.origin === "material")))) fail("Story needs a preserved material basis.");
  if (story.unknowns.some(u => !story.blocks.some(b => b.unknownIds.includes(u.id)))) fail("Each open question must remain attached to the narrative.");
  for (const block of story.blocks) { refs(block.basisRefs); if (block.unknownIds.some(id => !unknowns.has(id))) fail("Story references an unknown open question."); }
  if (story.blocks[0]?.title !== story.coreMessage) fail("The story opening must be the exact core message.");
  const core = selectedChoice.text;
  if (snapshot.request.kind === "develop_direction" && story.coreMessage !== core) fail("Initial story must preserve the selected core message.");
  if(snapshot.request.kind==="develop_direction" && (Boolean(humanWording)||selectedChoice.kind==="source_quote")) {
    const basis=story.bases.find(b=>humanWording ? b.kind==="consultant_judgment"&&b.userInputId===humanWording.userInputId&&b.statement===humanWording.text : selectedChoice.kind==="source_quote"&&b.kind==="source_excerpt"&&b.sourceId===selectedChoice.sourceId&&b.chunkId===selectedChoice.chunkId&&b.quote===selectedChoice.text);
    if(!basis||!story.blocks[0]!.basisRefs.includes(basis.id))fail("The retained opening wording must preserve its exact human or source attribution.");
  }

  const english = !/\p{Script=Han}/u.test(snapshot.understanding.nextQuestion.question);
  for (const [index, block] of story.blocks.entries()) {
    const unchanged = snapshot.before?.blocks.find(b => b.id === block.id);
    if (block.wording === "user_edited_unreviewed" && (!unchanged || block.title !== unchanged.title || block.body !== unchanged.body)) fail("Model output cannot claim to be an exact human edit.");
    const preserved = unchanged?.title === block.title || (index === 0 && snapshot.request.kind === "develop_direction");
    if (english && ((!preserved && block.title.trim().split(/\s+/).length > 12) || (block.wording !== "user_edited_unreviewed" && block.body.trim().split(/\s+/).length > 45))) fail("Generated story exceeded the concise title or body limit.");
  }
  if (english && snapshot.request.kind === "revise_story" && snapshot.before?.coreMessage !== story.coreMessage && (story.coreMessage.length > 100 || story.coreMessage.trim().split(/\s+/).length > 12)) fail("Generated core message exceeds 12 words or 100 characters.");
  return story;
}
export function exactStoryEdit(snapshot: StorySnapshot): Story {
  if (snapshot.request.kind !== "exact_edit" || !snapshot.before || !snapshot.userInput) throw new PitchroomError("INVALID_INPUT", "An exact edit requires an adopted story.");
  const story = structuredClone(snapshot.before), request = snapshot.request;
  const block = story.blocks.find(b => b.id === request.blockId);
  if (!block) throw new PitchroomError("INVALID_INPUT", "The edited story block is unavailable.");
  block.title = request.title; block.body = request.body; block.wording = "user_edited_unreviewed";
  const id = `input-${snapshot.userInput.id}`;
  story.bases.push({ kind: "consultant_judgment", id, userInputId: snapshot.userInput.id, statement: snapshot.userInput.text });
  block.basisRefs = [id];
  if (story.blocks[0]?.id === block.id) story.coreMessage = block.title;
  return storySchema.parse(story);
}

export function storySelectedChoice(snapshot:StorySnapshot) {
  const applied=readPositioning({id:snapshot.origin.positioningVersionId,proposal:snapshot.positioning,appliedDirectionId:snapshot.origin.directionId}).applied;
  if(!applied || applied.choice.id!==snapshot.origin.directionId || applied.positioningId!==snapshot.origin.positioningVersionId || snapshot.origin.positioningDecisionId && applied.decisionId!==snapshot.origin.positioningDecisionId || snapshot.selectedChoice && !samePositioningChoice(snapshot.selectedChoice,applied.choice)) throw new PitchroomError("PROPOSAL_REJECTED","The story selection does not match its frozen positioning decision.");
  return snapshot.selectedChoice ?? applied.choice;
}
