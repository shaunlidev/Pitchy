import { describe, expect, it } from "vitest";
import type { AgentEvent, SourceRecord, UnderstandingProposalV1 } from "@pitchroom/domain";
import { FakeUnderstandingAgentRunner } from "@pitchroom/testkit";
import { executePersistedUnderstandingRun, type PersistedRunStore } from "./persisted-run";

const source: SourceRecord = { id: "source", projectId: "project", name: "brief", mediaType: "text/plain", contentHash: "hash", chunks: [{ id: "chunk", sourceId: "source", text: "Revenue grew 40 percent.", startOffset: 0, endOffset: 24 }] };
const proposal: UnderstandingProposalV1 = { schemaVersion: 1, themes: [{ title: "Growth", summary: "Growth", claims: [{ statement: "Revenue grew 40 percent.", evidenceState: "supported", evidence: [{ sourceId: "source", chunkId: "chunk", quote: "Revenue grew 40 percent." }], userInputIds: [] }] }], gaps: [], nextQuestion: { question: "What drove it?", whyItMatters: "Tests durability", relatedThemeIndexes: [0] } };

function makeStore() {
  const events: AgentEvent[] = []; let failed = false; let cancelled = false;
  const store: PersistedRunStore = {
    async getProject() { return { id: "project", phase: "materials_ready", version: 0 }; },
    async listSources() { return [source]; },
    async createRun() { return { id: "run" }; },
    async appendEvent(event) { events.push(event); },
    async completeRun() { return { id: "understanding", version: 1 }; },
    async failRun() { failed = true; },
    async cancelRun() { cancelled = true; },
  };
  return { store, events, didFail: () => failed, didCancel: () => cancelled };
}

describe("persisted understanding run", () => {
  it("persists the validated proposal and ordered lifecycle events", async () => {
    const fixture = makeStore();
    const result = await executePersistedUnderstandingRun({ projectId: "project", idempotencyKey: "request", promptVersion: "v1", model: "fake", runner: new FakeUnderstandingAgentRunner({ proposal, publicSummary: "summary" }), store: fixture.store, now: () => "2026-10-14T00:00:00.000Z" });
    expect(result).toMatchObject({ phase: "review_required", version: 1 });
    expect(fixture.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fixture.events.at(-1)?.type).toBe("run_completed");
  });

  it("persists a terminal failure", async () => {
    const fixture = makeStore();
    const runner = { async run() { throw new Error("model failed"); } };
    await expect(executePersistedUnderstandingRun({ projectId: "project", idempotencyKey: "request", promptVersion: "v1", model: "fake", runner, store: fixture.store })).rejects.toThrow("model failed");
    expect(fixture.didFail()).toBe(true);
    expect(fixture.events.at(-1)?.type).toBe("run_failed");
  });

  it("persists runner tool trace and terminal metrics in sequence", async () => {
    const fixture = makeStore();
    const runner = { async run() { return { proposal, publicSummary: "summary", trace: [{ type: "tool_called" as const, payload: { name: "read_chunk" } }, { type: "tool_succeeded" as const, payload: { name: "read_chunk", durationMs: 3 } }], metrics: { stepCount: 1, toolCallCount: 1 } }; } };
    await executePersistedUnderstandingRun({ projectId: "project", idempotencyKey: "trace-request", promptVersion: "v1", model: "fake", runner, store: fixture.store });
    expect(fixture.events.map((event) => event.type)).toEqual(["run_started", "phase_changed", "tool_called", "tool_succeeded", "proposal_received", "version_created", "phase_changed", "run_completed"]);
    expect(fixture.events.at(-1)?.payload.metrics).toEqual({ stepCount: 1, toolCallCount: 1 });
  });

  it("propagates cancellation and persists a distinct cancelled terminal state", async () => {
    const fixture = makeStore();
    const controller = new AbortController();
    const runner = { async run(input: { signal?: AbortSignal }) { return new Promise<never>((_resolve, reject) => { if (input.signal?.aborted) reject(new Error("provider aborted")); else input.signal?.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true }); }); } };
    const running = executePersistedUnderstandingRun({ projectId: "project", idempotencyKey: "cancel-request", promptVersion: "v1", model: "fake", runner, store: fixture.store, signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toThrow("Run was cancelled");
    expect(fixture.didCancel()).toBe(true);
    expect(fixture.didFail()).toBe(false);
    expect(fixture.events.at(-1)?.type).toBe("run_cancelled");
  });
});
