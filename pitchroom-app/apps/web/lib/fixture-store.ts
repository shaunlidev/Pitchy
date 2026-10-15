import { PitchroomError, defaultProjectCharacterLimit, ingestMaterial, type PositioningProposalV1, type ProjectPhase, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { buildDeterministicPositioning, buildDeterministicUnderstanding } from "@pitchroom/agent";

type Version = { id: string; number: number; proposal: UnderstandingProposalV1; createdBy: "agent" | "user"; createdAt: string };
type PositioningVersion = { id: string; number: number; proposal: PositioningProposalV1; appliedDirectionId?: string; previousAppliedDirectionId?: string; createdAt: string };
export type FixtureState = {
  mode: "synthetic-fixture" | "postgres-fake" | "live";
  project: { id: string; name: string; phase: ProjectPhase; revision: number };
  sources: ReturnType<typeof ingestMaterial>[];
  versions: Version[];
  currentVersionId?: string;
  positioning?: PositioningVersion;
  events: Array<{ sequence: number; label: string; detail: string; at: string }>;
};

const makeState = (): FixtureState => ({ mode: "synthetic-fixture", project: { id: "00000000-0000-4000-8000-000000000001", name: "Atelier pitch", phase: "empty", revision: 0 }, sources: [], versions: [], events: [] });
const globalStore = globalThis as typeof globalThis & { __pitchroomFixture?: FixtureState };
const state = globalStore.__pitchroomFixture ?? makeState();
globalStore.__pitchroomFixture = state;
const addEvent = (label: string, detail: string) => state.events.push({ sequence: state.events.length + 1, label, detail, at: new Date().toISOString() });
export const readFixtureState = (): FixtureState => structuredClone(state);
export function resetFixtureState() { Object.assign(state, makeState()); return readFixtureState(); }

export function addFixtureMaterial(input: { name: string; mediaType: "text/plain" | "text/markdown"; text: string }) {
  if (state.project.phase === "reading" || state.project.phase === "structuring") {
    throw new PitchroomError("INVALID_TRANSITION", `Material cannot be added while the project is ${state.project.phase}.`);
  }
  const material = ingestMaterial(state.project.id, input);
  if (!state.sources.some((source) => source.contentHash === material.contentHash) && state.sources.reduce((total, source) => total + source.content.length, 0) + material.content.length > defaultProjectCharacterLimit) throw new PitchroomError("INVALID_INPUT", "Material would exceed the project text limit.", { limit: defaultProjectCharacterLimit });
  if (!state.sources.some((source) => source.contentHash === material.contentHash)) state.sources.push(material);
  state.project.phase = "materials_ready";
  state.currentVersionId = undefined;
  state.positioning = undefined;
  addEvent("Material ready", `${material.name} · ${material.chunks.length} chunk${material.chunks.length === 1 ? "" : "s"}`);
  return readFixtureState();
}

export function removeFixtureMaterial(sourceId: string) {
  if (state.project.phase === "reading" || state.project.phase === "structuring") throw new PitchroomError("CONFLICT", "Material cannot be removed while the agent is running.");
  const index = state.sources.findIndex((source) => source.sourceId === sourceId);
  if (index < 0) throw new PitchroomError("NOT_FOUND", "Material was not found in this project.");
  const [removed] = state.sources.splice(index, 1);
  state.currentVersionId = undefined;
  state.positioning = undefined;
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
  if (state.project.phase !== "review_required" || state.project.revision !== expectedRevision) throw new PitchroomError("CONFLICT", "This view is stale. Refresh before changing the current version.");
  const current = state.versions.find((version) => version.id === state.currentVersionId); if (!current) throw new PitchroomError("NOT_FOUND", "No understanding version is ready for review.");
  const proposal = structuredClone(current.proposal);
  const claim = proposal.themes[themeIndex]?.claims[claimIndex];
  if (!claim) throw new PitchroomError("INVALID_INPUT", "The selected claim is no longer available. Refresh and choose it again.");
  proposal.themes[themeIndex]!.claims[claimIndex] = { statement: text.trim(), evidenceState: "user_asserted", evidence: [], userInputIds: [`input-${state.project.revision + 1}`] };
  const version: Version = { id: `version-${state.versions.length + 1}`, number: state.versions.length + 1, proposal, createdBy: "user", createdAt: new Date().toISOString() };
  state.versions.push(version); state.currentVersionId = version.id; state.project.revision += 1;
  addEvent("User correction recorded", `Created version ${version.number}; source attribution was not reused`);
  return readFixtureState();
}

export function answerFixtureQuestion(text: string, expectedRevision: number) {
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
  if (state.project.phase !== "review_required" || state.project.revision !== expectedRevision) throw new PitchroomError("CONFLICT", "This view is stale. Refresh before preserving the unknown.");
  const current = state.versions.find((version) => version.id === state.currentVersionId); if (!current) throw new PitchroomError("NOT_FOUND", "No understanding version is ready for review.");
  const version: Version = { id: `version-${state.versions.length + 1}`, number: state.versions.length + 1, proposal: structuredClone(current.proposal), createdBy: "user", createdAt: new Date().toISOString() };
  state.versions.push(version); state.currentVersionId = version.id; state.project.revision += 1;
  addEvent("Unknown preserved", `Created version ${version.number}; no missing fact was inferred`);
  return readFixtureState();
}

export function acceptFixture(expectedRevision: number) {
  if (state.project.phase !== "review_required" || state.project.revision !== expectedRevision) throw new PitchroomError("CONFLICT", "Only the current reviewed version can be accepted.");
  state.project.phase = "accepted"; addEvent("Understanding accepted", `${state.currentVersionId} accepted by synthetic-local-user`); return readFixtureState();
}

export function generateFixturePositioning(expectedRevision: number = state.project.revision) {
  if (state.project.phase !== "accepted" || state.project.revision !== expectedRevision || !state.currentVersionId) throw new PitchroomError("CONFLICT", "Accept the current understanding before creating positioning directions.");
  const current = state.versions.find((version) => version.id === state.currentVersionId);
  if (!current) throw new PitchroomError("NOT_FOUND", "The accepted understanding was not found.");
  const proposal = buildDeterministicPositioning({ understandingVersionId: current.id, understanding: current.proposal, chunks: state.sources.flatMap((source) => source.chunks) });
  state.positioning = { id: `positioning-${Date.now()}`, number: (state.positioning?.number ?? 0) + 1, proposal, createdAt: new Date().toISOString() };
  addEvent("Positioning proposed", `${proposal.directions.length} source-grounded directions ready for review`);
  return readFixtureState();
}

export function applyFixturePositioning(directionId: string, expectedRevision: number) {
  if (state.project.phase !== "accepted" || state.project.revision !== expectedRevision || !state.positioning) throw new PitchroomError("CONFLICT", "This positioning view is stale or not ready.");
  if (directionId !== "original" && !state.positioning.proposal.directions.some((direction) => direction.id === directionId)) throw new PitchroomError("INVALID_INPUT", "The selected direction does not exist.");
  state.positioning.previousAppliedDirectionId = state.positioning.appliedDirectionId;
  state.positioning.appliedDirectionId = directionId;
  addEvent("Positioning applied", directionId === "original" ? "Original framing retained" : `${directionId} applied by user`);
  return readFixtureState();
}

export function undoFixturePositioning(expectedRevision: number) {
  if (state.project.phase !== "accepted" || state.project.revision !== expectedRevision || !state.positioning?.appliedDirectionId) throw new PitchroomError("CONFLICT", "There is no current positioning change to undo.");
  state.positioning.appliedDirectionId = state.positioning.previousAppliedDirectionId;
  state.positioning.previousAppliedDirectionId = undefined;
  addEvent("Positioning undone", "The latest applied direction was reversed");
  return readFixtureState();
}
