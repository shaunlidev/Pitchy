import { topicRefSchema, topicLabel, sameTopic, type TopicMaterial, type TopicRef } from "@pitchroom/domain";
import { ingestBrief, briefText, saveBriefSchema, stableHash, normalizeMaterialText, type BriefWorkspace } from "@pitchroom/domain";
import { SyntheticStoryRunner } from "@pitchroom/agent";
import { assertStoryHead, sameStoryOrigin, storyIsFresh, sourceFingerprint, compareStories, exactStoryEdit, storyToDeck, type StoryHead, type StoryRequest, type StorySnapshot, type StoryProposal } from "@pitchroom/domain";
import { classifyClarificationFailure } from "@pitchroom/agent";
import { recordClaimCorrection } from "@pitchroom/domain";
import { buildReassessmentContext, newClarification, clarificationPending, assertClarificationFresh, buildClarificationCandidate, type ClarificationTask, type SourceRecord, type ClarificationResult } from "@pitchroom/domain";
import { DeterministicClarificationRunner, evaluateClarification } from "@pitchroom/agent";
import { PitchroomError, defaultProjectCharacterLimit, ingestMaterial, type DeckProposal, type StoryWorkspace, type PositioningProposalV1, type ProjectPhase, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { buildDeterministicDeck, buildDeterministicPositioning, buildDeterministicUnderstanding, isInstructionLikeSourceText } from "@pitchroom/agent";

type Version = { parentUnderstandingId?: string; clarificationTaskId?: string; id: string; number: number; proposal: UnderstandingProposalV1; createdBy: "agent" | "user"; createdAt: string };
type PositioningVersion = { id: string; number: number; proposal: PositioningProposalV1; appliedDirectionId?: string; previousAppliedDirectionId?: string; createdAt: string };
type DeckVersion = { id: string; number: number; proposal: DeckProposal; createdBy: "agent" | "user"; createdAt: string };
type WorkflowRun = { id: string; kind: "positioning" | "deck" | "story"; status: "running" | "completed" | "failed"; failureMessage?: string; events: Array<{ type: string; detail: string; at: string }> };
export type AgentReview = { status: "quarantined"; affectedChunks: number; message: string };
type WorkspaceMaterial = ReturnType<typeof ingestMaterial> & { kind?: "file" | "brief"; agentReview?: AgentReview };
export type FixtureState = {
  mode: "synthetic-fixture" | "postgres-fake" | "live";
  project: { id: string; name: string; phase: ProjectPhase; revision: number };
  sources: WorkspaceMaterial[];
  topicMaterials?: TopicMaterial[];
  removedSources?: WorkspaceMaterial[];
  brief?: BriefWorkspace;
  versions: Version[];
  currentVersionId?: string;
  positioning?: PositioningVersion;
  positioningVersions: PositioningVersion[];
  deck?: DeckVersion & { stale: boolean };
  deckVersions: DeckVersion[];
  clarifications?: ClarificationTask[];
  story?: StoryWorkspace;
  workflowRuns: WorkflowRun[];
  events: Array<{ sequence: number; label: string; detail: string; at: string }>;
};

const makeState = (): FixtureState => ({ mode: "synthetic-fixture", project: { id: "00000000-0000-4000-8000-000000000001", name: "Atelier pitch", phase: "empty", revision: 0 }, brief: { head: null, versions: [] }, topicMaterials: [], removedSources: [], sources: [], versions: [], positioningVersions: [], deckVersions: [], workflowRuns: [], clarifications: [], events: [] });
const globalStore = globalThis as typeof globalThis & { __pitchroomFixture?: FixtureState };
const state = globalStore.__pitchroomFixture ?? makeState();
globalStore.__pitchroomFixture = state;
const addEvent = (label: string, detail: string) => state.events.push({ sequence: state.events.length + 1, label, detail, at: new Date().toISOString() });
export function agentReviewForChunks(chunks: Array<{ text: string }>): AgentReview | undefined {
  const affectedChunks = chunks.filter((chunk) => isInstructionLikeSourceText(chunk.text)).length;
  return affectedChunks > 0 ? {
    status: "quarantined",
    affectedChunks,
    message: "The original remains available, but the agent will not use the flagged passage. Remove or replace this source with a cleaned copy to include it.",
  } : undefined;
}
export const readFixtureState = (): FixtureState => {
  for (const task of state.clarifications ?? []) if (clarificationPending(task)) {
    try { assertClarificationFresh(task, clarificationCurrent()); } catch { task.status = "stale"; }
  }
  if (state.story) {
    const current = state.story.versions.find(v=>v.id===state.story?.head.storyId);
    state.story.stale = Boolean(current && !storyIsFresh(current.story.origin,storyContext()));
    for (const p of state.story.proposals) if (["ready","running","failed","no_change"].includes(p.state.kind) && (JSON.stringify(p.baseHead)!==JSON.stringify(state.story.head)||!storyIsFresh(p.snapshot.origin,storyContext()))) p.state={kind:"stale",explanation:"Inputs changed.",savedCandidate:p.state.kind==="ready"?p.state.candidate:null};
    if (state.deck?.proposal.schemaVersion === 2) state.deck.stale = state.story.stale || state.deck.proposal.storyVersionId !== state.story.head.storyId || state.deck.proposal.storyGeneration !== state.story.head.generation;
  }
  return structuredClone(state);
};
export function resetFixtureState() { delete state.story; storyReceipts.clear(); briefReceipts.clear(); topicReceipts.clear(); Object.assign(state, makeState()); return readFixtureState(); }

const briefReceipts = new Map<string, string>();
function fixtureStoredCharacters() {
  const briefSources = new Map((state.brief?.versions ?? []).flatMap(version => version.entry.kind === "saved" ? [[version.entry.sourceId, version.entry.text] satisfies [string, string]] : []));
  return state.sources.filter(source => source.kind !== "brief").reduce((sum, source) => sum + source.content.length, 0) + [...briefSources.values()].reduce((sum, text) => sum + text.length, 0);
}
export function saveFixtureBrief(raw: unknown) {
  const input = saveBriefSchema.parse(raw);
  const hash = stableHash(JSON.stringify([input.expectedVersionId, normalizeMaterialText(input.text)]));
  const prior = briefReceipts.get(input.commandId);
  if (prior) { if (prior !== hash) throw new PitchroomError("CONFLICT", "Command already used for another brief change."); return readFixtureState(); }
  if (["reading", "structuring"].includes(state.project.phase)) throw new PitchroomError("INVALID_TRANSITION", "Wait for the current material run before changing the brief.");
  const work = state.brief ?? { head: null, versions: [] };
  if ((work.head?.id ?? null) !== input.expectedVersionId) throw new PitchroomError("CONFLICT", "The brief changed in another tab. Review the latest version; your draft was preserved.");
  const material = ingestBrief(state.project.id, input.text);
  if (work.head && ((material && briefText(work) === material.content) || (!material && work.head.entry.kind === "cleared"))) { briefReceipts.set(input.commandId, hash); return readFixtureState(); }
  const oldBriefs = new Map(work.versions.flatMap(v => v.entry.kind === "saved" ? [[v.entry.sourceId, v.entry.text] satisfies [string, string]] : []));
  const used = fixtureStoredCharacters();
  if (material && !oldBriefs.has(material.sourceId) && used + material.content.length > defaultProjectCharacterLimit) throw new PitchroomError("INVALID_INPUT", "Brief history would exceed the project text limit.");
  state.sources = state.sources.filter(source => source.kind !== "brief");
  if (material) state.sources.push({ ...material, kind: "brief", agentReview: agentReviewForChunks(material.chunks) });
  const version: import("@pitchroom/domain").BriefVersion = { id: crypto.randomUUID(), number: work.versions.length + 1, createdAt: new Date().toISOString(), entry: material ? { kind: "saved", sourceId: material.sourceId, contentHash: material.contentHash, text: material.content } : { kind: "cleared" } };
  state.brief = { head: version, versions: [...work.versions, version] };
  state.currentVersionId = undefined; state.positioning = undefined;
  state.project.phase = state.sources.length ? "materials_ready" : "empty";
  if (state.deck) state.deck.stale = true;
  briefReceipts.set(input.commandId, hash);
  addEvent("Brief saved", version.entry.kind === "cleared" ? "Brief removed from current context; history retained" : `Written brief version ${version.number}`);
  return readFixtureState();
}

export function addFixtureMaterial(input: { name: string; mediaType: "text/plain" | "text/markdown"; text: string }) {
  if (state.project.phase === "reading" || state.project.phase === "structuring") {
    throw new PitchroomError("INVALID_TRANSITION", `Material cannot be added while the project is ${state.project.phase}.`);
  }
  const ingested = ingestMaterial(state.project.id, input);
  const material: WorkspaceMaterial = { ...ingested, agentReview: agentReviewForChunks(ingested.chunks) };
  if (!state.sources.some((source) => source.contentHash === material.contentHash && source.kind !== "brief") && fixtureStoredCharacters() + material.content.length > defaultProjectCharacterLimit) throw new PitchroomError("INVALID_INPUT", "Material would exceed the project text limit.", { limit: defaultProjectCharacterLimit });
  if (!state.sources.some((source) => source.contentHash === material.contentHash && source.kind !== "brief")) state.sources.push(material);
  state.removedSources = (state.removedSources ?? []).filter(source => source.sourceId !== material.sourceId);
  state.project.phase = "materials_ready";
  state.currentVersionId = undefined;
  state.positioning = undefined;
  if (state.deck) state.deck.stale = true;
  addEvent("Material ready", `${material.name} · ${material.chunks.length} chunk${material.chunks.length === 1 ? "" : "s"}`);
  if (material.agentReview) addEvent("Agent review required", `${material.name} · ${material.agentReview.affectedChunks} passage${material.agentReview.affectedChunks === 1 ? "" : "s"} isolated from agent use`);
  return readFixtureState();
}

export function removeFixtureMaterial(sourceId: string) {
  if (state.project.phase === "reading" || state.project.phase === "structuring") throw new PitchroomError("CONFLICT", "Material cannot be removed while the agent is running.");
  const index = state.sources.findIndex((source) => source.sourceId === sourceId && source.kind !== "brief");
  if (index < 0) throw new PitchroomError("NOT_FOUND", "Material was not found in this project.");
  const [removed] = state.sources.splice(index, 1);
  if (removed) (state.removedSources ??= []).push(removed);
  state.topicMaterials = (state.topicMaterials ?? []).filter(link => link.sourceId !== sourceId);
  state.currentVersionId = undefined;
  state.positioning = undefined;
  if (state.deck) state.deck.stale = true;
  state.project.phase = state.sources.length ? "materials_ready" : "empty";
  addEvent("Material removed", `${removed!.name} removed from the active project; prior versions remain in history`);
  return readFixtureState();
}

export function runFixtureAgent() {
  const source = state.sources[0];
  if (!source) throw new PitchroomError("INVALID_TRANSITION", "Add material before starting the agent.");
  state.project.phase = "reading";
  addEvent("Agent started", "Bounded synthetic runner; no external model call");
  addEvent("Tool · list_sources", `Found ${state.sources.length} source${state.sources.length === 1 ? "" : "s"}`);
  for (const material of state.sources) for (const chunk of material.chunks) addEvent("Tool · read_chunk", `${chunk.id} · ${chunk.text.length} characters`);
  const { proposal } = buildDeterministicUnderstanding({ projectId: state.project.id, chunks: state.sources.flatMap((material) => material.chunks) });
  const version: Version = { id: `version-${state.versions.length + 1}`, number: state.versions.length + 1, proposal, createdBy: "agent", createdAt: new Date().toISOString() };
  state.versions.push(version); state.currentVersionId = version.id; state.project.revision += 1; state.project.phase = "review_required";
  addEvent("Proposal validated", "Schema and exact-quote provenance passed"); addEvent("Review required", "Agent stopped before approval");
  return readFixtureState();
}

export function correctFixtureClaim(text: string, themeIndex: number, claimIndex: number, expectedRevision: number) {
  assertNoPendingClarification();
  if (state.project.phase !== "review_required" || state.project.revision !== expectedRevision) throw new PitchroomError("CONFLICT", "This view is stale. Refresh before changing the current version.");
  const current = state.versions.find((version) => version.id === state.currentVersionId); if (!current) throw new PitchroomError("NOT_FOUND", "No understanding version is ready for review.");
  const proposal = structuredClone(current.proposal);
  const claim = proposal.themes[themeIndex]?.claims[claimIndex];
  if (!claim) throw new PitchroomError("INVALID_INPUT", "The selected claim is no longer available. Refresh and choose it again.");
  recordClaimCorrection(proposal, themeIndex, claimIndex, text, `input-${state.project.revision + 1}`);
  const version: Version = { id: `version-${state.versions.length + 1}`, number: state.versions.length + 1, proposal, createdBy: "user", createdAt: new Date().toISOString() };
  state.versions.push(version); state.currentVersionId = version.id; state.project.revision += 1;
  addEvent("User correction recorded", `Created version ${version.number}; source attribution was not reused`);
  return readFixtureState();
}

export function answerFixtureQuestion(text: string, expectedRevision: number) {
  assertNoPendingClarification();
  if (state.project.phase !== "review_required" || state.project.revision !== expectedRevision) throw new PitchroomError("CONFLICT", "This view is stale. Refresh before answering the current question.");
  const current = state.versions.find((version) => version.id === state.currentVersionId); if (!current) throw new PitchroomError("NOT_FOUND", "No understanding version is ready for review.");
  const proposal = structuredClone(current.proposal);
  proposal.themes[proposal.nextQuestion.relatedThemeIndexes[0] ?? 0]!.claims.push({ statement: text.trim(), evidenceState: "user_asserted", evidence: [], userInputIds: [`input-${state.project.revision + 1}`] });
  const version: Version = { id: `version-${state.versions.length + 1}`, number: state.versions.length + 1, proposal, createdBy: "user", createdAt: new Date().toISOString() };
  state.versions.push(version); state.currentVersionId = version.id; state.project.revision += 1;
  addEvent("User answer recorded", `Created version ${version.number}; answer remains user-attributed`);
  return readFixtureState();
}

export function keepFixtureUnknown(expectedRevision: number) {
  assertNoPendingClarification();
  if (state.project.phase !== "review_required" || state.project.revision !== expectedRevision) throw new PitchroomError("CONFLICT", "This view is stale. Refresh before preserving the unknown.");
  const current = state.versions.find((version) => version.id === state.currentVersionId); if (!current) throw new PitchroomError("NOT_FOUND", "No understanding version is ready for review.");
  const version: Version = { id: `version-${state.versions.length + 1}`, number: state.versions.length + 1, proposal: structuredClone(current.proposal), createdBy: "user", createdAt: new Date().toISOString() };
  state.versions.push(version); state.currentVersionId = version.id; state.project.revision += 1;
  addEvent("Unknown preserved", `Created version ${version.number}; no missing fact was inferred`);
  return readFixtureState();
}

export function acceptFixture(expectedRevision: number) {
  assertNoPendingClarification();
  if (state.project.phase !== "review_required" || state.project.revision !== expectedRevision) throw new PitchroomError("CONFLICT", "Only the current reviewed version can be accepted.");
  state.project.phase = "accepted"; addEvent("Understanding accepted", `${state.currentVersionId} accepted by synthetic-local-user`); return readFixtureState();
}

export function generateFixturePositioning(expectedRevision: number = state.project.revision) {
  if (state.project.phase !== "accepted" || state.project.revision !== expectedRevision || !state.currentVersionId) throw new PitchroomError("CONFLICT", "Accept the current understanding before creating positioning directions.");
  const current = state.versions.find((version) => version.id === state.currentVersionId);
  if (!current) throw new PitchroomError("NOT_FOUND", "The accepted understanding was not found.");
  const proposal = buildDeterministicPositioning({ understandingVersionId: current.id, understanding: current.proposal, chunks: state.sources.flatMap((source) => source.chunks) });
  state.positioning = { id: `positioning-${Date.now()}`, number: (state.positioningVersions.at(-1)?.number ?? 0) + 1, proposal, createdAt: new Date().toISOString() };
  state.positioningVersions.push(state.positioning);
  if (state.deck) state.deck.stale = true;
  addEvent("Positioning proposed", `${proposal.directions.length} source-grounded directions ready for review`);
  return readFixtureState();
}

export function applyFixturePositioning(directionId: string, expectedRevision: number) {
  if (state.project.phase !== "accepted" || state.project.revision !== expectedRevision || !state.positioning) throw new PitchroomError("CONFLICT", "This positioning view is stale or not ready.");
  if (directionId !== "original" && !state.positioning.proposal.directions.some((direction) => direction.id === directionId)) throw new PitchroomError("INVALID_INPUT", "The selected direction does not exist.");
  state.positioning.previousAppliedDirectionId = state.positioning.appliedDirectionId;
  state.positioning.appliedDirectionId = directionId;
  if (state.deck && state.deck.proposal.appliedDirectionId !== directionId) state.deck.stale = true;
  addEvent("Positioning applied", directionId === "original" ? "Original framing retained" : `${directionId} applied by user`);
  return readFixtureState();
}

export function undoFixturePositioning(expectedRevision: number) {
  if (state.project.phase !== "accepted" || state.project.revision !== expectedRevision || !state.positioning?.appliedDirectionId) throw new PitchroomError("CONFLICT", "There is no current positioning change to undo.");
  state.positioning.appliedDirectionId = state.positioning.previousAppliedDirectionId;
  state.positioning.previousAppliedDirectionId = undefined;
  if (state.deck && state.deck.proposal.appliedDirectionId !== state.positioning.appliedDirectionId) state.deck.stale = true;
  addEvent("Positioning undone", "The latest applied direction was reversed");
  return readFixtureState();
}

export function adjustFixturePositioning(directionId: string, mode: "headline" | "judgment_note", text: string, expectedRevision: number) {
  if (state.project.phase !== "accepted" || state.project.revision !== expectedRevision || !state.positioning) throw new PitchroomError("CONFLICT", "This positioning view is stale or not ready.");
  const proposal = structuredClone(state.positioning.proposal); const direction = proposal.directions.find((candidate) => candidate.id === directionId);
  if (!direction) throw new PitchroomError("INVALID_INPUT", "Only a proposed direction can be adjusted.");
  if (mode === "headline") direction.coreMessage = text.trim(); else direction.judgmentNote = text.trim(); direction.userInputIds = [...direction.userInputIds, `positioning-input-${Date.now()}`];
  state.positioning = { id: `positioning-${Date.now()}`, number: (state.positioningVersions.at(-1)?.number ?? state.positioning.number) + 1, proposal, createdAt: new Date().toISOString() };
  state.positioningVersions.push(state.positioning);
  if (state.deck) state.deck.stale = true; addEvent("Positioning adjusted", `${mode === "headline" ? "Exact headline" : "Judgment note"} saved as user input`); return readFixtureState();
}

export function generateFixtureDeck(expectedRevision: number) {
  if (state.project.phase !== "accepted" || state.project.revision !== expectedRevision || !state.positioning?.appliedDirectionId || !state.currentVersionId) throw new PitchroomError("CONFLICT", "Apply a current positioning direction before creating a deck.");
  const understanding = state.versions.find((version) => version.id === state.currentVersionId);
  if (!understanding) throw new PitchroomError("NOT_FOUND", "The accepted understanding was not found.");
  const run: WorkflowRun = { id: `deck-run-${Date.now()}`, kind: "deck", status: "running", events: [{ type: "run_started", detail: "deck generation started", at: new Date().toISOString() }] };
  state.workflowRuns.push(run);
  try {
    const proposal = buildDeterministicDeck({ understandingVersionId: understanding.id, understanding: understanding.proposal, positioningVersionId: state.positioning.id, positioning: state.positioning.proposal, appliedDirectionId: state.positioning.appliedDirectionId, chunks: state.sources.flatMap((source) => source.chunks) });
    const version: DeckVersion = { id: `deck-${state.deckVersions.length + 1}`, number: state.deckVersions.length + 1, proposal, createdBy: "agent", createdAt: new Date().toISOString() };
    state.deckVersions.push(version); state.deck = { ...version, stale: false }; run.status = "completed"; run.events.push({ type: "run_completed", detail: "five-page deck persisted", at: new Date().toISOString() });
    addEvent("Deck created", `Draft ${version.number} · five pages`);
    return readFixtureState();
  } catch (error) {
    run.status = "failed"; run.failureMessage = error instanceof Error ? error.message : "Deck generation failed"; run.events.push({ type: "run_failed", detail: run.failureMessage, at: new Date().toISOString() }); throw error;
  }
}

export function editFixtureDeckPage(deckId: string, expectedDeckVersion: number, pageId: string, title: string, body: string) {
  const current = state.deckVersions.at(-1);
  if (!current || current.id !== deckId || current.number !== expectedDeckVersion) throw new PitchroomError("CONFLICT", "This deck draft is stale.");
  const proposal = structuredClone(current.proposal); const page = proposal.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new PitchroomError("INVALID_INPUT", "The selected deck page does not exist.");
  page.title = title; page.body = body; if ("wording" in page) page.wording = "user_edited_unreviewed";
  const version: DeckVersion = { id: `deck-${state.deckVersions.length + 1}`, number: state.deckVersions.length + 1, proposal, createdBy: "user", createdAt: new Date().toISOString() };
  state.deckVersions.push(version); state.deck = { ...version, stale: false }; addEvent("Deck page edited", `Draft ${version.number} created; prior draft remains read-only`); return readFixtureState();
}

function clarificationSources(): SourceRecord[] { return state.sources.map(source => ({ ...source, id: source.sourceId, projectId: state.project.id })); }
function clarificationCurrent() { return { phase: state.project.phase, revision: state.project.revision, understandingId: state.currentVersionId, sources: clarificationSources() }; }
function assertNoPendingClarification() { readFixtureState(); if (state.clarifications?.some(clarificationPending)) throw new PitchroomError("CONFLICT", "Resolve the current clarification before changing or accepting this version."); }
export function submitFixtureClarification(input: { text: string; expectedRevision: number; commandId: string; rebaseTaskId?: string }) {
  readFixtureState(); state.clarifications ??= [];
  const existing = state.clarifications.find(t => t.commandId === input.commandId);
  if (existing) {
    if (existing.answer !== input.text || existing.baseRevision !== input.expectedRevision || existing.reassessment?.rebasedFromTaskId !== input.rebaseTaskId) throw new PitchroomError("CONFLICT", "Command ID was used for different input.");
    return readFixtureState();
  }
  if ((state.project.phase !== "review_required" && state.project.phase !== "accepted") || state.project.revision !== input.expectedRevision || !state.currentVersionId) throw new PitchroomError("CONFLICT", "Clarification requires the current review version.");
  assertNoPendingClarification();
  const prior = input.rebaseTaskId ? state.clarifications.find(t => t.id === input.rebaseTaskId) : undefined;
  if (input.rebaseTaskId && (!prior || prior.status !== "stale" || prior.answer !== input.text)) throw new PitchroomError("CONFLICT", "Only a stale answer can be rebased.");
  const current = state.versions.find(v => v.id === state.currentVersionId)!;
  const id = crypto.randomUUID();
  const task = newClarification({ id, inputId: prior?.inputId ?? crypto.randomUUID(), projectId: state.project.id, commandId: input.commandId, actorId: "synthetic-local-user", versionId: current.id, revision: state.project.revision, basePhase: state.project.phase, base: current.proposal, sources: clarificationSources(), reassessment: prior ? buildReassessmentContext(prior, clarificationSources()) : undefined, answer: input.text });
  state.clarifications.push(task); addEvent("Answer saved", "Clarification queued; current understanding unchanged");
  scheduleFixtureClarification(task); return readFixtureState();
}
function scheduleFixtureClarification(task: ClarificationTask) {
  // Fixture only: PostgreSQL uses the independent leased worker.
  setTimeout(() => { void runFixtureClarification(task.id); }, 100);
}
export async function runFixtureClarification(id: string) {
  const task = state.clarifications?.find(t => t.id === id); if (!task || task.status !== "queued") return;
  task.status = "running"; const attempt = task.attempts.at(-1)!; attempt.status = "running"; attempt.model = "deterministic-local"; attempt.startedAt = new Date().toISOString();
  addEvent("Clarification running", "Reassessing the saved answer against current understanding");
  try {
    const output = await evaluateClarification(task,new DeterministicClarificationRunner());
    if (task.status !== "running") return;
    assertClarificationFresh(task,clarificationCurrent());
    task.result = output.result; task.candidate = output.candidate; task.status = output.result.operations.length ? "proposal_ready" : "no_change"; attempt.status = "completed";
  } catch (error) { if (task.status !== "running") return; attempt.status = "failed"; attempt.failure = classifyClarificationFailure(error); attempt.error = attempt.failure.code; try { assertClarificationFresh(task,clarificationCurrent()); task.status = "failed"; } catch { task.status = "stale"; } }
  attempt.finishedAt = new Date().toISOString(); addEvent("Clarification updated", task.status);
}
export function decideFixtureClarification(input: { taskId: string; action: "apply" | "dismiss" | "retry"; commandId: string; result?: ClarificationResult }) {
  readFixtureState(); const task = state.clarifications?.find(t => t.id === input.taskId);
  if (!task) throw new PitchroomError("NOT_FOUND", "Clarification not found.");
  const decisionRequest = JSON.stringify({action:input.action,result:input.action === "apply" ? input.result ?? task.result : undefined});
  if (["applied","dismissed"].includes(task.status)) { if (task.decisionCommandId === input.commandId && task.decisionRequest === decisionRequest) return readFixtureState(); throw new PitchroomError("CONFLICT", "Clarification already resolved."); }
  if (input.action === "dismiss") { task.status = "dismissed"; task.decisionCommandId = input.commandId; task.decisionRequest = decisionRequest; }
  else {
    assertClarificationFresh(task,clarificationCurrent());
    if (input.action === "retry") {
      if (task.attempts.some(a => a.commandId === input.commandId)) return readFixtureState();
      if (task.status !== "failed") throw new PitchroomError("CONFLICT", "Only failed analysis can be retried.");
      task.status = "queued"; task.attempts.push({ id: `${task.id}:attempt:${task.attempts.length+1}`, commandId: input.commandId, status: "queued", model: "deterministic-local", promptVersion: "clarify-feedback-v4" }); scheduleFixtureClarification(task);
    } else {
      if (task.status !== "proposal_ready" || !task.result) throw new PitchroomError("CONFLICT", "Proposal is not ready.");
      const proposal = buildClarificationCandidate(task,input.result ?? task.result); const version = { parentUnderstandingId: task.baseUnderstandingId, clarificationTaskId: task.id, id: `version-${state.versions.length+1}`, number: state.project.revision+1, proposal, createdBy: "user" as const, createdAt: new Date().toISOString() };
      state.versions.push(version); state.currentVersionId = version.id; state.project.revision += 1; state.project.phase = "review_required"; state.positioning = undefined; if (state.deck) state.deck.stale = true;
      task.status = "applied"; task.appliedResult = input.result ?? task.result; task.resultVersionId = version.id; task.decisionCommandId = input.commandId; task.decisionRequest = decisionRequest;
    }
  }
  addEvent("Clarification decision", task.status); return readFixtureState();
}

const storyReceipts = new Map<string,string>();
function fixtureStory() { return state.story ??= {head:{generation:0,storyId:null},versions:[],proposals:[],stale:false}; }
function storyContext() { return { phase:state.project.phase,understandingId:state.currentVersionId??null,positioningId:state.positioning?.id??null,directionId:state.positioning?.appliedDirectionId??null,sources:clarificationSources() }; }
export async function proposeFixtureStory(input:{expected:StoryHead;commandId:string;request:StoryRequest;retryOf?:string}) {
  const work=fixtureStory(), hash=JSON.stringify(input), existing=work.proposals.find(p=>p.commandId===input.commandId);
  if(existing){if(storyReceipts.get(input.commandId)!==hash)throw new PitchroomError("CONFLICT","Command ID was reused.");return readFixtureState();}
  assertStoryHead(input.expected,work.head);
  const positioning=state.positioning, understanding=state.versions.find(v=>v.id===state.currentVersionId);
  if(state.project.phase!=="accepted"||!positioning?.appliedDirectionId||!understanding)throw new PitchroomError("CONFLICT","Accept understanding and choose a direction first.");
  const prior=input.retryOf?work.proposals.find(p=>p.id===input.retryOf):undefined;
  if(prior){assertStoryHead(prior.baseHead,work.head);if(!storyIsFresh(prior.snapshot.origin,storyContext())||JSON.stringify(prior.snapshot.request)!==JSON.stringify(input.request))throw new PitchroomError("CONFLICT","Retry inputs changed.");}
  if(work.proposals.some(p=>p.id!==input.retryOf&&(p.state.kind==="ready"||p.state.kind==="running")))throw new PitchroomError("CONFLICT","Resolve the current story proposal first.");
  work.proposals.forEach(p=>{if(p.state.kind!=="applied"&&p.state.kind!=="kept"){p.savedResult=p.state;p.state={kind:"kept",commandId:input.commandId};}});
  const before=work.versions.find(v=>v.id===work.head.storyId)?.story??null;
  if(!["develop_direction","restore"].includes(input.request.kind)&&(!before||!storyIsFresh(before.origin,storyContext())))throw new PitchroomError("CONFLICT","Develop a current story first.");
  const text=input.request.kind==="revise_story"?input.request.judgment:input.request.kind==="exact_edit"?`${input.request.title}\n${input.request.body}`:null;
  const snapshot:StorySnapshot=prior?.snapshot??{origin:{understandingVersionId:understanding.id,positioningVersionId:positioning.id,directionId:positioning.appliedDirectionId,sourceFingerprint:sourceFingerprint(clarificationSources())},understanding:understanding.proposal,positioning:positioning.proposal,sources:clarificationSources(),before,request:input.request,userInput:text?{id:crypto.randomUUID(),text}:null,model:"synthetic-story",promptVersion:"story-v1"};
  const p:StoryProposal={id:crypto.randomUUID(),projectId:state.project.id,commandId:input.commandId,createdAt:new Date().toISOString(),baseHead:structuredClone(work.head),snapshot,state:{kind:"running",attemptId:crypto.randomUUID(),deadline:new Date(Date.now()+120000).toISOString()}};
  work.proposals.push(p);storyReceipts.set(input.commandId,hash);
  try {
    const local=input.request.kind==="exact_edit"?exactStoryEdit(snapshot):input.request.kind==="restore"?work.versions.find(v=>input.request.kind==="restore"&&v.id===input.request.storyId)?.story:undefined;
    if(input.request.kind==="restore"&&(!local||!sameStoryOrigin(local.origin,snapshot.origin)))throw new PitchroomError("CONFLICT","Saved story has different accepted inputs.");
    const result=local?{story:structuredClone(local),responseToJudgment:"Exact saved wording proposed for review."}:await new SyntheticStoryRunner().run(snapshot);
    const diff=compareStories(before,result.story),id=crypto.randomUUID();
    if(!diff.fields.length&&!diff.blocks.length)p.state={kind:"no_change",explanation:result.responseToJudgment};
    else {p.state={kind:"ready",candidateId:id,candidate:result.story,diff,responseToJudgment:result.responseToJudgment};work.versions.push({id,parentId:work.head.storyId,proposalId:p.id,story:result.story,snapshot,createdAt:new Date().toISOString()});}
  }catch(error){p.state={kind:"failed",explanation:error instanceof Error?error.message:"Story failed."};}
  return readFixtureState();
}
function replayStoryCommand(input:{commandId:string}) {const hash=JSON.stringify(input),saved=storyReceipts.get(input.commandId);if(saved&&saved!==hash)throw new PitchroomError("CONFLICT","Command ID was reused.");return {hash,replayed:Boolean(saved)};}
export function decideFixtureStory(input:{expected:StoryHead;proposalId:string;commandId:string;decision:"apply"|"keep_current"}) {
  const replay=replayStoryCommand(input);if(replay.replayed)return readFixtureState();
  const work=fixtureStory(),p=work.proposals.find(p=>p.id===input.proposalId);if(!p)throw new PitchroomError("NOT_FOUND","Proposal unavailable.");
  if(p.state.kind==="applied"||p.state.kind==="kept")throw new PitchroomError("CONFLICT","Proposal resolved.");
  p.savedResult=p.state;
  if(input.decision==="keep_current")p.state={kind:"kept",commandId:input.commandId};
  else {assertStoryHead(input.expected,work.head);assertStoryHead(p.baseHead,work.head);if(p.state.kind!=="ready"||!storyIsFresh(p.snapshot.origin,storyContext()))throw new PitchroomError("CONFLICT","Proposal is stale.");work.head={storyId:p.state.candidateId,generation:work.head.generation+1};p.state={kind:"applied",storyId:work.head.storyId!,generation:work.head.generation,commandId:input.commandId};}
  storyReceipts.set(input.commandId,replay.hash);return readFixtureState();
}
export function undoFixtureStory(input:{expected:StoryHead;commandId:string}) {
  const replay=replayStoryCommand(input);if(replay.replayed)return readFixtureState();const work=fixtureStory();assertStoryHead(input.expected,work.head);const version=work.versions.find(v=>v.id===work.head.storyId);if(!version)throw new PitchroomError("CONFLICT","No adopted story.");work.head={storyId:version.parentId,generation:work.head.generation+1};storyReceipts.set(input.commandId,replay.hash);return readFixtureState();
}
export function createFixtureStoryDeck(input:{expected:StoryHead;commandId:string}) {
  const replay=replayStoryCommand(input);if(replay.replayed)return readFixtureState();const work=fixtureStory();assertStoryHead(input.expected,work.head);const version=work.versions.find(v=>v.id===work.head.storyId);if(!version||!storyIsFresh(version.story.origin,storyContext()))throw new PitchroomError("CONFLICT","Adopt a current story first.");const deck:DeckVersion={id:crypto.randomUUID(),number:state.deckVersions.length+1,proposal:storyToDeck({storyId:version.id,generation:work.head.generation,story:version.story}),createdBy:"agent",createdAt:new Date().toISOString()};state.deckVersions.push(deck);state.deck={...deck,stale:false};storyReceipts.set(input.commandId,replay.hash);return readFixtureState();
}

const topicReceipts = new Map<string, string>();
export function changeFixtureTopicMaterial(input: { topic: TopicRef; commandId: string } & ({ action: "attach"; material: { name: string; mediaType: "text/plain" | "text/markdown"; text: string } } | { action: "link" | "unlink"; sourceId: string })) {
  const topic = topicRefSchema.parse(input.topic);
  const material = input.action === "attach" ? ingestMaterial(state.project.id, input.material) : undefined;
  const hash = stableHash(JSON.stringify([input.action, topic, input.action === "attach" ? material?.contentHash : input.sourceId]));
  const prior = topicReceipts.get(input.commandId);
  if (prior) { if (prior !== hash) throw new PitchroomError("CONFLICT", "Command already used for another material change."); return readFixtureState(); }
  if (["reading", "structuring"].includes(state.project.phase)) throw new PitchroomError("CONFLICT", "Wait for the current material run.");
  const version = state.versions.find(version => version.id === topic.understandingId);
  if (!version) throw new PitchroomError("NOT_FOUND", "The original Understanding was not found.");
  const label = topicLabel(version.proposal, topic);
  if (input.action !== "unlink" && state.currentVersionId !== topic.understandingId) throw new PitchroomError("CONFLICT", "This topic belongs to an older Understanding. Refresh before attaching material.");
  const sourceId = material?.sourceId ?? (input.action !== "attach" ? input.sourceId : "");
  if (material) {
    if (!state.sources.some(source => source.sourceId === sourceId)) {
      if (fixtureStoredCharacters() + material.content.length > defaultProjectCharacterLimit) throw new PitchroomError("INVALID_INPUT", "Material would exceed the project text limit.");
      state.sources.push({ ...material, agentReview: agentReviewForChunks(material.chunks) });
    }
    state.removedSources = (state.removedSources ?? []).filter(source => source.sourceId !== sourceId);
  } else if (!state.sources.some(source => source.sourceId === sourceId && source.kind !== "brief")) throw new PitchroomError("NOT_FOUND", "The source is not in the active project.");
  const links = state.topicMaterials ??= [];
  if (input.action === "unlink") state.topicMaterials = links.filter(link => !(link.sourceId === sourceId && sameTopic(link, topic)));
  else if (!links.some(link => link.sourceId === sourceId && sameTopic(link, topic))) links.push({ ...topic, sourceId, label, status: "needs_review" });
  topicReceipts.set(input.commandId, hash);
  return readFixtureState();
}
