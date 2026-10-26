import { describe, expect, it } from "vitest";
import { FakeUnderstandingAgentRunner } from "@pitchroom/testkit";
import { runUnderstandingAgent } from "./index";

const chunks = [
  {
    id: "chunk-1",
    sourceId: "source-1",
    text: "Customers replace ageing equipment before the summer peak.",
    startOffset: 0,
    endOffset: 58,
  },
];

describe("runUnderstandingAgent", () => {
  it("stops at review_required after validating the proposal", async () => {
    const runner = new FakeUnderstandingAgentRunner({
      proposal: {
        schemaVersion: 1,
        themes: [
          {
            title: "Buying moment",
            summary: "Replacement is linked to seasonal risk.",
            claims: [
              {
                statement: "Customers replace equipment before summer.",
                evidenceState: "supported",
                evidence: [
                  {
                    sourceId: "source-1",
                    chunkId: "chunk-1",
                    quote: "before the summer peak",
                  },
                ],
                userInputIds: [],
              },
            ],
          },
        ],
        gaps: [],
        nextQuestion: {
          question: "What makes replacement urgent?",
          whyItMatters: "It identifies the buying trigger.",
          relatedThemeIndexes: [0],
        },
      },
      publicSummary: "I found one supported buying-moment claim.",
    });

    const outcome = await runUnderstandingAgent(
      "materials_ready",
      { projectId: "project-1", chunks },
      runner,
    );

    expect(outcome.phase).toBe("review_required");
    expect(runner.inputs).toHaveLength(1);
  });

  it("rejects an agent attempt to invent user attribution", async () => {
    const runner = new FakeUnderstandingAgentRunner({
      proposal: {
        schemaVersion: 1,
        themes: [{ title: "Invalid attribution", summary: "The agent must not impersonate the user.", claims: [{ statement: "The user said so.", evidenceState: "user_asserted", evidence: [], userInputIds: ["fabricated-input"] }] }],
        gaps: [],
        nextQuestion: { question: "What did the user actually say?", whyItMatters: "Attribution is a trust boundary.", relatedThemeIndexes: [0] },
      },
      publicSummary: "Invalid",
    });
    await expect(runUnderstandingAgent("materials_ready", { projectId: "project-1", chunks }, runner)).rejects.toThrow("cannot create user-attributed claims");
  });
});
