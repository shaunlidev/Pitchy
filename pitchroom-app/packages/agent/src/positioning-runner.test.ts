import { describe, expect, it } from "vitest";
import { buildDeterministicPositioning, ResponsesPositioningRunner } from "./positioning-runner";

const input = {
  understandingVersionId: "version-1",
  chunks: [{ id: "chunk-1", sourceId: "source-1", text: "Teams recover two days of preparation.", startOffset: 0, endOffset: 39 }],
  understanding: { schemaVersion: 1 as const, themes: [{ title: "Speed", summary: "Preparation is faster.", claims: [{ statement: "Teams recover two days.", evidenceState: "supported" as const, evidence: [{ sourceId: "source-1", chunkId: "chunk-1", quote: "recover two days" }], userInputIds: [] }] }], gaps: [], nextQuestion: { question: "Which decision matters most?", whyItMatters: "It sets emphasis.", relatedThemeIndexes: [0] } },
};

describe("deterministic positioning runner", () => {
  it("creates distinct reviewable directions from supported material", () => {
    const result = buildDeterministicPositioning(input);
    expect(result.directions).toHaveLength(2);
    expect(new Set(result.directions.map((direction) => direction.coreMessage)).size).toBe(2);
    expect(result.originalFraming.title).toBe("Original framing");
  });

  it("validates the mocked Responses API adapter without making a live call", async () => {
    const proposal = buildDeterministicPositioning(input);
    const mockFetch = (async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(proposal) }] }] }), { status: 200 })) as typeof fetch;
    const result = await new ResponsesPositioningRunner({ apiKey: "test-key", model: "pinned-model", baseURL: "https://example.test/v1", fetch: mockFetch }).run(input);
    expect(result.understandingVersionId).toBe(input.understandingVersionId);
  });
});
