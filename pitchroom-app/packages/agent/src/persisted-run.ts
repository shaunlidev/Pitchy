import { PitchroomError, type AgentEvent, type ProjectPhase, type SourceRecord, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { runUnderstandingAgent, type UnderstandingAgentRunner } from "./controller";

export type PersistedRunStore = {
  getProject(projectId: string): Promise<{ id: string; phase: ProjectPhase; version: number } | undefined>;
  listSources(projectId: string): Promise<SourceRecord[]>;
  createRun(projectId: string, idempotencyKey: string, promptVersion: string, model: string): Promise<{ id: string }>;
  appendEvent(event: AgentEvent): Promise<void>;
  completeRun(input: { projectId: string; runId: string; expectedRevision: number; proposal: UnderstandingProposalV1 }): Promise<{ id: string; version: number }>;
  failRun(input: { projectId: string; runId: string; message: string }): Promise<void>;
  cancelRun(input: { projectId: string; runId: string; message: string }): Promise<void>;
};

export async function executePersistedUnderstandingRun(input: {
  projectId: string;
  idempotencyKey: string;
  promptVersion: string;
  model: string;
  runner: UnderstandingAgentRunner;
  store: PersistedRunStore;
  now?: () => string;
  signal?: AbortSignal;
}) {
  const project = await input.store.getProject(input.projectId);
  if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
  if (project.phase !== "materials_ready" && project.phase !== "cancelled" && project.phase !== "failed") throw new PitchroomError("CONFLICT", "A run can start only when materials are ready or a stopped run is retried.");
  const startingPhase = project.phase;
  const sources = await input.store.listSources(input.projectId);
  if (sources.length === 0) throw new PitchroomError("INVALID_INPUT", "At least one material source is required.");
  const run = await input.store.createRun(input.projectId, input.idempotencyKey, input.promptVersion, input.model);
  const now = input.now ?? (() => new Date().toISOString());
  let sequence = 0;
  const append = (type: AgentEvent["type"], payload: Record<string, unknown>) => input.store.appendEvent({ runId: run.id, sequence: ++sequence, type, timestamp: now(), payload });
  await append("run_started", { projectId: input.projectId, promptVersion: input.promptVersion, model: input.model });
  await append("phase_changed", { from: startingPhase, to: "reading" });
  let streamedTraceCount = 0;
  try {
    const result = await runUnderstandingAgent("materials_ready", {
      projectId: input.projectId,
      chunks: sources.flatMap((source) => source.chunks),
      signal: input.signal,
      onTrace: async (traceEvent) => {
        await append(traceEvent.type, traceEvent.payload);
        streamedTraceCount += 1;
      },
    }, input.runner);
    for (const traceEvent of result.trace.slice(streamedTraceCount)) await append(traceEvent.type, traceEvent.payload);
    await append("proposal_received", { schemaVersion: result.proposal.schemaVersion });
    const version = await input.store.completeRun({ projectId: input.projectId, runId: run.id, expectedRevision: project.version, proposal: result.proposal });
    await append("version_created", { understandingId: version.id, version: version.version });
    await append("phase_changed", { from: "structuring", to: "review_required" });
    await append("run_completed", { understandingId: version.id, ...(result.metrics ? { metrics: result.metrics } : {}) });
    return { runId: run.id, understandingId: version.id, version: version.version, phase: result.phase, publicSummary: result.publicSummary };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown run failure";
    const failedTrace = error && typeof error === "object" && "trace" in error && Array.isArray(error.trace)
      ? error.trace as AgentEvent[]
      : [];
    for (const traceEvent of failedTrace.slice(streamedTraceCount)) await append(traceEvent.type, traceEvent.payload);
    if (input.signal?.aborted || (error instanceof PitchroomError && error.code === "CANCELLED")) {
      await append("phase_changed", { from: "reading", to: "cancelled" });
      await append("run_cancelled", { message });
      await input.store.cancelRun({ projectId: input.projectId, runId: run.id, message });
      throw new PitchroomError("CANCELLED", "Run was cancelled.");
    }
    await append("run_failed", { message });
    await input.store.failRun({ projectId: input.projectId, runId: run.id, message });
    throw error;
  }
}
