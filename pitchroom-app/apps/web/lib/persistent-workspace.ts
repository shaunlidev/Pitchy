import { DeterministicUnderstandingRunner, createLiveUnderstandingRunner, executePersistedUnderstandingRun } from "@pitchroom/agent";
import { createDatabase, PitchroomRepository } from "@pitchroom/persistence";
import { PitchroomError, type UnderstandingProposalV1 } from "@pitchroom/domain";
import type { FixtureState } from "./fixture-store";

const globals = globalThis as typeof globalThis & { __pitchroomDatabase?: ReturnType<typeof createDatabase>; __pitchroomRepository?: PitchroomRepository };

function repository() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required for postgres-fake mode.");
  globals.__pitchroomDatabase ??= createDatabase(url);
  // Next.js preserves globalThis across development hot reloads. Recreate a
  // cached class instance when its prototype predates the current module.
  if (!globals.__pitchroomRepository || typeof globals.__pitchroomRepository.removeMaterial !== "function") {
    globals.__pitchroomRepository = new PitchroomRepository(globals.__pitchroomDatabase.db);
  }
  return globals.__pitchroomRepository;
}

async function project() {
  const found = await repository().ensureProject("atelier", "Atelier pitch");
  if (!found) throw new Error("Persistent project could not be created.");
  return found;
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
  const [sources, versions, eventRows] = await Promise.all([repository().listSources(currentProject.id), repository().listVersions(currentProject.id), repository().listEvents(currentProject.id)]);
  return {
    mode,
    project: { id: currentProject.id, name: currentProject.name, phase: currentProject.phase, revision: currentProject.version },
    sources: sources.map((source) => ({ sourceId: source.id, name: source.name, mediaType: source.mediaType as "text/plain" | "text/markdown", content: reconstructSourceContent(source.chunks), contentHash: source.contentHash, chunks: source.chunks.map((chunk, ordinal) => ({ ...chunk, ordinal })) })),
    versions: versions.map((version) => ({ id: version.id, number: version.version, proposal: version.proposal, createdBy: version.createdBy === "user" ? "user" : "agent", createdAt: version.createdAt.toISOString() })),
    currentVersionId: currentProject.currentUnderstandingId ?? undefined,
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

export async function correctPersistentClaim(text: string, expectedRevision: number, idempotencyKey: string) {
  const { currentProject, proposal } = await currentProposal(expectedRevision);
  proposal.themes[0]!.claims[0] = { statement: text.trim(), evidenceState: "user_asserted", evidence: [], userInputIds: ["assigned-transactionally"] };
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
