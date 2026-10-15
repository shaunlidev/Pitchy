import { describe, expect, it } from "vitest";
import { buildDeterministicPositioning } from "./positioning-runner";

describe("deterministic positioning runner", () => {
  it("creates distinct reviewable directions from supported material", () => {
    const chunk = { id: "chunk-1", sourceId: "source-1", text: "Teams recover two days of preparation.", startOffset: 0, endOffset: 39 };
    const result = buildDeterministicPositioning({
      understandingVersionId: "version-1",
      chunks: [chunk],
      understanding: { schemaVersion: 1, themes: [{ title: "Speed", summary: "Preparation is faster.", claims: [{ statement: "Teams recover two days.", evidenceState: "supported", evidence: [{ sourceId: chunk.sourceId, chunkId: chunk.id, quote: "recover two days" }], userInputIds: [] }] }], gaps: [], nextQuestion: { question: "Which decision matters most?", whyItMatters: "It sets emphasis.", relatedThemeIndexes: [0] } },
    });
    expect(result.directions).toHaveLength(2);
    expect(new Set(result.directions.map((direction) => direction.coreMessage)).size).toBe(2);
    expect(result.originalFraming.title).toBe("Original framing");
  });
});
