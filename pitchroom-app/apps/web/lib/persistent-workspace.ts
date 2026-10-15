import { DeterministicDeckRunner, DeterministicPositioningRunner, DeterministicUnderstandingRunner, createLiveDeckRunner, createLivePositioningRunner, createLiveUnderstandingRunner, executePersistedUnderstandingRun } from "@pitchroom/agent";
import { createDatabase, PitchroomRepository } from "@pitchroom/persistence";
import { PitchroomError, type UnderstandingProposalV1 } from "@pitchroom/domain";
import type { FixtureState } from "./fixture-store";

const globals = globalThis as typeof globalThis & { __pitchroomDatabase?: ReturnType<typeof createDatabase>; __pitchroomRepository?: PitchroomRepository };

export function repositoryNeedsRefresh(value: unknown): boolean {
  return !value || Object.getPrototypeOf(value) !== PitchroomRepository.prototype;
}

function repository() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for postgres-fake mode.");
  globals.__pitchroomDatabase ??= createDatabase(url);
  // Next.js preserves globalThis across development hot reloads. Comparing the
  // complete prototype identity prevents any newly added repository method from
  // being missed by a one-off capability check.
  if (repositoryNeedsRefresh(globals.__pitchroomRepository)) {
    globals.__pitchroomRepository = new PitchroomRepository(globals.__pitchroomDatabase.db);
  }
  return globals.__pitchroomRepository!;
}

async function project() {
  const found = await repository().ensureProject("atelier", "Atelier pitch");
  if (!found) throw new Error("Persistent project could not be created.");
  return found;
}

async function recoverPersistedWorkflowResult(input: { projectId: string; idempotencyKey: string; commandType: "generate_positioning" | "generate_deck"; runId: string; runStatus: string }) {
  const receipt = await repository().getCommandReceipt(input.projectId, input.idempotencyKey);
  if (!receipt || receipt.commandType !== input.commandType) return false;
  if (input.runStatus !== "completed") await repository().completeWorkflowRun(input.runId, receipt.resourceId);
  return true;
}

function eventView(type: string, payload: Record<string, unknown>) {
  const labels: Record<string, string> = { run_started: "Agent started", phase_changed: "Phase changed", proposal_received: "Proposal received", version_created: "Version created", run_completed: "Review required", run_failed: "Agent failed" };
  return { label: labels[type] ?? type.replaceAll("_", " "), detail: Object.entries(payload).map(([key, value]) => `${key}: ${String(value)}`).join(" · ") || "Recorded" };
}

export function reconstructSourceContent(chunks: Array<{ startOffset: number; text: string }>) {
  return [...chunks]
    .sort((left, right) => left.startOffset - right.startOffset)
    .reduce((content, chunk) => content + chunk.text.slice(Math.max(0, content.length - chunk.startOffset)), "");
}

export async function readPersistentState(mode: "postgres-fake" | "live" = "postgres-fake"): Promise<FixtureState> {
  const currentProject = await project();
  const [sources, versions, eventRows, positioning, deck, deckVersions, workflowRuns] = await Promise.all([repository().listSources(currentProject.id), repository().listVersions(currentProject.id), repository().listEvents(currentProject.id), repository().getCurrentPositioning(currentProject.id), repository().getCurrentDeck(currentProject.id), repository().listDeckVersions(currentProject.id), repository().listWorkflowRuns(currentProject.id)]);
  const deckStale = Boolean(deck && (deck.understandingId !== currentProject.currentUnderstandingId || deck.positioningId !== currentProject.currentPositioningId || deck.appliedDirectionId !== positioning?.appliedDirectionId));
  return {
    mode,
    project: { id: currentProject.id, name: currentProject.name, phase: currentProject.phase, revision: currentProject.version },
    sources: sources.map((source) => ({ sourceId: source.id, name: source.name, mediaType: source.mediaType as "text/plain" | "text/markdown", content: reconstructSourceContent(source.chunks), contentHash: source.contentHash, chunks: source.chunks.map((chunk, ordinal) => ({ ...chunk, ordinal })) })),
    versions: versions.map((version) => ({ id: version.id, number: version.version, proposal: version.proposal, createdBy: version.createdBy === "user" ? "user" : "agent", createdAt: version.createdAt.toISOString() })),
    currentVersionId: currentProject.currentUnderstandingId ?? undefined,
    positioning: positioning ? { id: positioning.id, number: positioning.version, proposal: positioning.proposal, appliedDirectionId: positioning.appliedDirectionId ?? undefined, previousAppliedDirectionId: positioning.previousAppliedDirectionId ?? undefined, createdAt: positioning.createdAt.toISOString() } : undefined,
    deck: deck ? { id: deck.id, number: deck.version, proposal: deck.proposal, createdBy: deck.createdBy === "user" ? "user" as const : "agent" as const, createdAt: deck.createdAt.toISOString(), stale: deckStale } : undefined,
    deckVersions: deckVersions.map((version) => ({ id: version.id, number: version.version, proposal: version.proposal, createdBy: version.createdBy === "user" ? "user" as const : "agent" as const, createdAt: version.createdAt.toISOString() })),
    workflowRuns: workflowRuns.map((run) => ({ id: run.id, kind: run.kind as "positioning" | "deck", status: run.status as "running" | "completed" | "failed", failureMessage: run.failureMessage ?? undefined, events: run.events })),
    events: eventRows.map(({ event }, index) => ({ sequence: index + 1, ...eventView(event.type, event.payload), at: event.createdAt.toISOString() })),
  };
}

export async function addPersistentMaterial(input: { name: string; mediaType: "text/plain" | "text/markdown"; text: string; idempotencyKey: string }) {
  const currentProject = await project();
  await repository().addMaterial(currentProject.id, input, input.idempotencyKey);
  return readPersistentState();
}

export async function removePersistentMaterial(sourceId: string) {
  const currentProject = await project();
  await repository().removeMaterial(currentProject.id, sourceId);
  return readPersistentState();
}

export async function runPersistentAgent(idempotencyKey: string, mode: "postgres-fake" | "live" = "postgres-fake", signal?: AbortSignal) {
  const currentProject = await project();
  if (mode === "live" && process.env.PITCHROOM_LIVE_TRANSFER_ACK !== "authorized") throw new PitchroomError("INVALID_INPUT", "PITCHROOM_LIVE_TRANSFER_ACK=authorized is required before external model transfer.");
  const runner = mode === "live" ? createLiveUnderstandingRunner(repository(), { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, baseURL: process.env.OPENAI_BASE_URL }) : new DeterministicUnderstandingRunner();
  await executePersistedUnderstandingRun({ projectId: currentProject.id, idempotencyKey, promptVersion: mode === "live" ? "understanding-live-v1" : "deterministic-v1", model: mode === "live" ? process.env.OPENAI_MODEL! : "deterministic-local", runner, store: repository(), signal });
  return readPersistentState(mode);
}

async function currentProposal(expectedRevision: number) {
  const currentProject = await project();
  if (currentProject.version !== expectedRevision || currentProject.phase !== "review_required" || !currentProject.currentUnderstandingId) throw new PitchroomError("CONFLICT", "This view is stale. Refresh before changing the current version.");
  const version = (await repository().listVersions(currentProject.id)).find((candidate) => candidate.id === currentProject.currentUnderstandingId);
  if (!version) throw new PitchroomError("NOT_FOUND", "The current understanding version was not found.");
  return { currentProject, proposal: structuredClone(version.proposal) as UnderstandingProposalV1 };
}

export async function correctPersistentClaim(text: string, themeIndex: number, claimIndex: number, expectedRevision: number, idempotencyKey: string) {
  const { currentProject, proposal } = await currentProposal(expectedRevision);
  const claim = proposal.themes[themeIndex]?.claims[claimIndex];
  if (!claim) throw new PitchroomError("INVALID_INPUT", "The selected claim is no longer available. Refresh and choose it again.");
  proposal.themes[themeIndex]!.claims[claimIndex] = { statement: text.trim(), evidenceState: "user_asserted", evidence: [], userInputIds: ["assigned-transactionally"] };
  await repository().createUserVersion({ projectId: currentProject.id, expectedRevision, kind: "correction", text, actorId: "synthetic-local-user", idempotencyKey, proposal });
  return readPersistentState();
}

export async function answerPersistentQuestion(text: string, expectedRevision: number, idempotencyKey: string) {
  const { currentProject, proposal } = await currentProposal(expectedRevision);
  proposal.themes[proposal.nextQuestion.relatedThemeIndexes[0] ?? 0]!.claims.push({ statement: text.trim(), evidenceState: "user_asserted", evidence: [], userInputIds: ["assigned-transactionally"] });
  await repository().createUserVersion({ projectId: currentProject.id, expectedRevision, kind: "answer", text, actorId: "synthetic-local-user", idempotencyKey, proposal });
  return readPersistentState();
}

export async function keepPersistentUnknown(expectedRevision: number, idempotencyKey: string) {
  const { currentProject, proposal } = await currentProposal(expectedRevision);
  await repository().createUserVersion({ projectId: currentProject.id, expectedRevision, kind: "keep_unknown", text: "Keep unknown", actorId: "synthetic-local-user", idempotencyKey, proposal });
  return readPersistentState();
}

export async function acceptPersistent(expectedRevision: number, idempotencyKey: string) {
  const currentProject = await project();
  if (!currentProject.currentUnderstandingId) throw new PitchroomError("CONFLICT", "No understanding is ready for acceptance.");
  await repository().acceptUnderstanding({ projectId: currentProject.id, understandingId: currentProject.currentUnderstandingId, expectedRevision, actorId: "synthetic-local-user", idempotencyKey });
  return readPersistentState();
}

export async function generatePersistentPositioning(expectedRevision: number, idempotencyKey: string, mode: "postgres-fake" | "live" = "postgres-fake") {
  const currentProject = await project();
  if (currentProject.phase !== "accepted" || currentProject.version !== expectedRevision || !currentProject.currentUnderstandingId) throw new PitchroomError("CONFLICT", "Accept the current understanding before creating positioning directions.");
  const version = (await repository().listVersions(currentProject.id)).find((candidate) => candidate.id === currentProject.currentUnderstandingId);
  if (!version) throw new PitchroomError("NOT_FOUND", "The accepted understanding was not found.");
  const sources = await repository().listSources(currentProject.id);
  const chunks = sources.flatMap((source) => source.chunks);
  if (mode === "live" && process.env.PITCHROOM_LIVE_TRANSFER_ACK !== "authorized") throw new PitchroomError("INVALID_INPUT", "PITCHROOM_LIVE_TRANSFER_ACK=authorized is required before external model transfer.");
  const runner = mode === "live" ? createLivePositioningRunner({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, baseURL: process.env.OPENAI_BASE_URL }) : new DeterministicPositioningRunner();
  const workflow = await repository().startWorkflowRun({ projectId: currentProject.id, kind: "positioning", targetRevision: expectedRevision, model: mode === "live" ? process.env.OPENAI_MODEL! : "deterministic-local", idempotencyKey });
  const run = workflow.run;
  if (!workflow.created) {
    if (await recoverPersistedWorkflowResult({ projectId: currentProject.id, idempotencyKey, commandType: "generate_positioning", runId: run.id, runStatus: run.status })) return readPersistentState(mode);
    if (run.status === "completed" && run.resultId) return readPersistentState(mode);
    if (run.status === "failed") throw new PitchroomError("PROPOSAL_REJECTED", run.failureMessage ?? "The previous positioning run failed.");
    throw new PitchroomError("CONFLICT", "This positioning command is already running.");
  }
  try {
    await repository().appendWorkflowEvent(run.id, "context_loaded", `${chunks.length} source chunks locked`);
    const proposal = await runner.run({ understandingVersionId: version.id, understanding: version.proposal, chunks });
    await repository().appendWorkflowEvent(run.id, "proposal_validated", `${proposal.directions.length} directions passed evidence validation`);
    const created = await repository().createPositioning({ projectId: currentProject.id, understandingId: version.id, expectedRevision, proposal, idempotencyKey });
    await repository().completeWorkflowRun(run.id, created.id);
    return readPersistentState(mode);
  } catch (error) {
    if (await recoverPersistedWorkflowResult({ projectId: currentProject.id, idempotencyKey, commandType: "generate_positioning", runId: run.id, runStatus: run.status })) return readPersistentState(mode);
    await repository().failWorkflowRun(run.id, error); throw error;
  }
}

export async function applyPersistentPositioning(directionId: string, expectedRevision: number, idempotencyKey: string) {
  const currentProject = await project();
  await repository().applyPositioning({ projectId: currentProject.id, directionId, expectedRevision, idempotencyKey });
  return readPersistentState();
}

export async function undoPersistentPositioning(expectedRevision: number, idempotencyKey: string) {
  const currentProject = await project();
  await repository().undoPositioning({ projectId: currentProject.id, expectedRevision, idempotencyKey });
  return readPersistentState();
}

export async function adjustPersistentPositioning(directionId: string, mode: "headline" | "judgment_note", text: string, expectedRevision: number, idempotencyKey: string) {
  const currentProject = await project();
  await repository().adjustPositioning({ projectId: currentProject.id, directionId, mode, text, expectedRevision, idempotencyKey });
  return readPersistentState();
}

export async function generatePersistentDeck(expectedRevision: number, idempotencyKey: string, mode: "postgres-fake" | "live" = "postgres-fake") {
  const currentProject = await project();
  const positioning = await repository().getCurrentPositioning(currentProject.id);
  if (currentProject.phase !== "accepted" || currentProject.version !== expectedRevision || !currentProject.currentUnderstandingId || !positioning?.appliedDirectionId) throw new PitchroomError("CONFLICT", "Apply a current positioning direction before creating a deck.");
  const understanding = (await repository().listVersions(currentProject.id)).find((candidate) => candidate.id === currentProject.currentUnderstandingId);
  if (!understanding) throw new PitchroomError("NOT_FOUND", "The accepted understanding was not found.");
  const sources = await repository().listSources(currentProject.id); const chunks = sources.flatMap((source) => source.chunks);
  if (mode === "live" && process.env.PITCHROOM_LIVE_TRANSFER_ACK !== "authorized") throw new PitchroomError("INVALID_INPUT", "PITCHROOM_LIVE_TRANSFER_ACK=authorized is required before external model transfer.");
  const runner = mode === "live" ? createLiveDeckRunner({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, baseURL: process.env.OPENAI_BASE_URL }) : new DeterministicDeckRunner();
  const workflow = await repository().startWorkflowRun({ projectId: currentProject.id, kind: "deck", targetRevision: expectedRevision, model: mode === "live" ? process.env.OPENAI_MODEL! : "deterministic-local", idempotencyKey });
  const run = workflow.run;
  if (!workflow.created) {
    if (await recoverPersistedWorkflowResult({ projectId: currentProject.id, idempotencyKey, commandType: "generate_deck", runId: run.id, runStatus: run.status })) return readPersistentState(mode);
    if (run.status === "completed" && run.resultId) return readPersistentState(mode);
    if (run.status === "failed") throw new PitchroomError("PROPOSAL_REJECTED", run.failureMessage ?? "The previous deck run failed.");
    throw new PitchroomError("CONFLICT", "This deck command is already running.");
  }
  try {
    await repository().appendWorkflowEvent(run.id, "inputs_locked", `understanding ${understanding.id}; positioning ${positioning.id}`);
    const proposal = await runner.run({ understandingVersionId: understanding.id, understanding: understanding.proposal, positioningVersionId: positioning.id, positioning: positioning.proposal, appliedDirectionId: positioning.appliedDirectionId, chunks });
    await repository().appendWorkflowEvent(run.id, "draft_validated", "five-page schema and evidence passed");
    const deck = await repository().createDeck({ projectId: currentProject.id, understandingId: understanding.id, positioningId: positioning.id, appliedDirectionId: positioning.appliedDirectionId, expectedRevision, proposal, idempotencyKey });
    await repository().completeWorkflowRun(run.id, deck.id); return readPersistentState(mode);
  } catch (error) {
    if (await recoverPersistedWorkflowResult({ projectId: currentProject.id, idempotencyKey, commandType: "generate_deck", runId: run.id, runStatus: run.status })) return readPersistentState(mode);
    await repository().failWorkflowRun(run.id, error); throw error;
  }
}

export async function editPersistentDeckPage(deckId: string, expectedDeckVersion: number, pageId: string, title: string, body: string, idempotencyKey: string) {
  const currentProject = await project();
  await repository().editDeckPage({ projectId: currentProject.id, deckId, expectedDeckVersion, pageId, title, body, idempotencyKey });
  return readPersistentState();
}
