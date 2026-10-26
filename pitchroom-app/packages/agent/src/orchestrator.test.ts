import { describe, expect, it } from "vitest";
import type { UnderstandingProposalV1 } from "@pitchroom/domain";
import { orchestrateUnderstandingRun, type AgentAction, type StepAgent } from "./orchestrator";
import type { SourceRecord, ToolRepository } from "./tools";

const source: SourceRecord = {
  id: "source-1",
  projectId: "project-1",
  name: "brief.md",
  mediaType: "text/markdown",
  contentHash: "hash",
  chunks: [
    {
      id: "chunk-1",
      sourceId: "source-1",
      text: "Revenue grew 40 percent in 2026.",
      startOffset: 0,
      endOffset: 32,
    },
  ],
};

const repository: ToolRepository = {
  async listSources(projectId) {
    return projectId === source.projectId ? [source] : [];
  },
  async getSource(projectId, sourceId) {
    return projectId === source.projectId && sourceId === source.id ? source : undefined;
  },
  async getChunk(projectId, chunkId) {
    return projectId === source.projectId ? source.chunks.find((chunk) => chunk.id === chunkId) : undefined;
  },
};

const proposal: UnderstandingProposalV1 = {
  schemaVersion: 1,
  themes: [
    {
      title: "Growth",
      summary: "The supplied brief reports growth.",
      claims: [
        {
          statement: "Revenue grew 40 percent in 2026.",
          evidenceState: "supported",
          evidence: [{ sourceId: "source-1", chunkId: "chunk-1", quote: "Revenue grew 40 percent" }],
          userInputIds: [],
        },
      ],
    },
  ],
  gaps: [{ description: "No customer count", whyItMatters: "Growth quality is unclear", relatedSourceIds: ["source-1"] }],
  nextQuestion: { question: "How many customers drove the growth?", whyItMatters: "It tests concentration", relatedThemeIndexes: [0] },
};

describe("orchestrateUnderstandingRun", () => {
  it("runs tools, validates evidence, and stops at review_required", async () => {
    const actions: StepAgent = {
      async next({ step }): Promise<AgentAction> {
        if (step === 1) return { type: "tool", call: { name: "list_sources", arguments: {} } };
        if (step === 2) return { type: "tool", call: { name: "read_chunk", arguments: { chunkId: "chunk-1" } } };
        return { type: "submit", proposal, publicSummary: "One grounded theme and one gap." };
      },
    };
    const result = await orchestrateUnderstandingRun({
      runId: "run-1",
      projectId: "project-1",
      currentPhase: "materials_ready",
      repository,
      agent: actions,
      now: () => "2026-10-14T00:00:00.000Z",
    });
    expect(result.phase).toBe("review_required");
    expect(result.events.map((event) => event.type)).toContain("run_completed");
    expect(result.events.at(-2)?.payload.to).toBe("review_required");
  });

  it("rejects fabricated evidence", async () => {
    const bad = structuredClone(proposal);
    bad.themes[0]!.claims[0]!.evidence[0]!.quote = "Fabricated quote";
    const agent: StepAgent = { async next() { return { type: "submit", proposal: bad, publicSummary: "bad" }; } };
    await expect(
      orchestrateUnderstandingRun({ runId: "run-2", projectId: "project-1", currentPhase: "materials_ready", repository, agent }),
    ).rejects.toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ type: "run_failed" })]) });
  });

  it("opens the repeated-call circuit breaker", async () => {
    const agent: StepAgent = { async next() { return { type: "tool", call: { name: "list_sources", arguments: {} } }; } };
    await expect(
      orchestrateUnderstandingRun({
        runId: "run-3",
        projectId: "project-1",
        currentPhase: "materials_ready",
        repository,
        agent,
        budgets: { maxSteps: 8, maxToolCalls: 20, maxRepeatedCall: 2 },
      }),
    ).rejects.toThrow("circuit breaker");
  });

  it("fails closed on cross-project chunk access", async () => {
    const agent: StepAgent = { async next() { return { type: "tool", call: { name: "read_chunk", arguments: { chunkId: "chunk-1" } } }; } };
    await expect(
      orchestrateUnderstandingRun({ runId: "run-4", projectId: "other", currentPhase: "materials_ready", repository, agent }),
    ).rejects.toThrow("not found in this project");
  });

  it("terminates a hung model step at the wall-clock deadline", async () => {
    const agent: StepAgent = { async next() { return new Promise(() => undefined); } };
    await expect(orchestrateUnderstandingRun({ runId: "run-timeout", projectId: "project-1", currentPhase: "materials_ready", repository, agent, budgets: { timeoutMs: 10 } })).rejects.toThrow("wall-clock budget exceeded");
  });

  it("propagates cancellation into a hung model step", async () => {
    const controller = new AbortController();
    const agent: StepAgent = { async next() { return new Promise(() => undefined); } };
    const run = orchestrateUnderstandingRun({ runId: "run-cancel", projectId: "project-1", currentPhase: "materials_ready", repository, agent, signal: controller.signal, budgets: { timeoutMs: 1_000 } });
    setTimeout(() => controller.abort(), 5);
    await expect(run).rejects.toThrow("cancelled");
  });

  it("allows bounded recovery from a transient tool failure", async () => {
    let attempts = 0;
    const transientRepository: ToolRepository = {
      ...repository,
      async getChunk(projectId, chunkId) {
        attempts += 1;
        if (attempts === 1) throw new Error("transient read failure");
        return repository.getChunk(projectId, chunkId);
      },
    };
    const agent: StepAgent = {
      async next({ step }) {
        if (step <= 2) return { type: "tool", call: { name: "read_chunk", arguments: { chunkId: "chunk-1" } } };
        return { type: "submit", proposal, publicSummary: "Recovered within the tool-failure budget." };
      },
    };
    const result = await orchestrateUnderstandingRun({ runId: "run-recovery", projectId: "project-1", currentPhase: "materials_ready", repository: transientRepository, agent });
    expect(result.events.map((event) => event.type)).toContain("tool_failed");
    expect(result.events.map((event) => event.type)).toContain("tool_succeeded");
    expect(result.phase).toBe("review_required");
  });

  it("stops after the consecutive tool-failure budget", async () => {
    const failingRepository: ToolRepository = { ...repository, async getChunk() { throw new Error("unavailable"); } };
    const agent: StepAgent = { async next() { return { type: "tool", call: { name: "read_chunk", arguments: { chunkId: "chunk-1" } } }; } };
    await expect(orchestrateUnderstandingRun({ runId: "run-failure-budget", projectId: "project-1", currentPhase: "materials_ready", repository: failingRepository, agent, budgets: { maxRepeatedCall: 3, maxConsecutiveToolFailures: 3 } })).rejects.toThrow("unavailable");
  });

  it("stops when tools exceed the returned-character budget", async () => {
    const agent: StepAgent = { async next() { return { type: "tool", call: { name: "read_chunk", arguments: { chunkId: "chunk-1" } } }; } };
    await expect(orchestrateUnderstandingRun({ runId: "run-output-budget", projectId: "project-1", currentPhase: "materials_ready", repository, agent, budgets: { maxReturnedCharacters: 10 } })).rejects.toThrow("character budget exceeded");
  });
});
