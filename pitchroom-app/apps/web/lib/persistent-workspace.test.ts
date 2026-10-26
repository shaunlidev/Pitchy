import { describe, expect, it } from "vitest";
import { PitchroomRepository } from "@pitchroom/persistence";
import { databaseNeedsRefresh, mergeWorkspaceStreamEvents, reconstructSourceContent, repositoryNeedsRefresh } from "./persistent-workspace";

describe("persistent workspace source reconstruction", () => {
  it("does not duplicate overlapping chunk text", () => {
    expect(reconstructSourceContent([
      { startOffset: 0, text: "abcdef" },
      { startOffset: 4, text: "efghij" },
    ])).toBe("abcdefghij");
  });

  it("is stable when chunks arrive out of order", () => {
    expect(reconstructSourceContent([
      { startOffset: 4, text: "efghij" },
      { startOffset: 0, text: "abcdef" },
    ])).toBe("abcdefghij");
  });
});

describe("persistent workspace development cache", () => {
  it("replaces repository objects created from an outdated hot-reload prototype", () => {
    expect(repositoryNeedsRefresh(Object.create({ removeMaterial() {} }))).toBe(true);
    expect(repositoryNeedsRefresh(Object.create(PitchroomRepository.prototype))).toBe(false);
  });

  it("rebinds a database whose hot-reload query map is missing a required table", () => {
    const queryEntry = { findFirst() {} };
    const currentDatabase = { db: { query: {
      briefVersions: queryEntry,
      clarificationTasks: queryEntry,
      projects: queryEntry,
      sources: queryEntry,
      commandReceipts: queryEntry,
      agentRuns: queryEntry,
      userInputs: queryEntry,
      understandingVersions: queryEntry,
      approvals: queryEntry,
      positioningVersions: queryEntry,
      workflowRuns: queryEntry,
      deckVersions: queryEntry,
      storyProposals: queryEntry,
      storyVersions: queryEntry,
    } } };

    expect(databaseNeedsRefresh(currentDatabase)).toBe(false);
    expect(databaseNeedsRefresh({ db: { query: { ...currentDatabase.db.query, positioningVersions: undefined } } })).toBe(true);
    expect(databaseNeedsRefresh(undefined)).toBe(true);
  });
});

describe("workspace stream projection", () => {
  it("merges understanding and workflow activity into one stable SSE sequence", () => {
    const events = mergeWorkspaceStreamEvents(
      [{ label: "Agent started", detail: "understanding", at: "2026-10-15T00:00:00.000Z" }],
      [{ id: "run", kind: "positioning", status: "running", events: [
        { type: "run_started", detail: "positioning generation started", at: "2026-10-15T00:00:01.000Z" },
        { type: "model_requested", detail: "generating", at: "2026-10-15T00:00:02.000Z" },
      ] }],
    );
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.label)).toEqual(["Agent started", "Positioning agent started", "Model generation started"]);
  });
  it("preserves Story failure history with Story labels", () => {
    const at = "2026-10-25T00:00:00.000Z";
    const events = mergeWorkspaceStreamEvents([], [{ id: "story-run", kind: "story", status: "failed", events: [
      { type: "run_started", detail: "story started", at },
      { type: "proposal_validated", detail: "story validated", at },
      { type: "run_failed", detail: "error: null", at },
    ] }]);
    expect(events.map(event => event.label)).toEqual(["Story agent started", "Story proposal validated", "Story agent failed"]);
    expect(events.at(-1)?.detail).toBe("error: null");
  });

});
