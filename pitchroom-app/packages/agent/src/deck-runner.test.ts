import { describe, expect, it } from "vitest";
import { buildDeterministicDeck, ResponsesDeckRunner } from "./deck-runner";

const input = {
  understandingVersionId: "u1",
  positioningVersionId: "p1",
  appliedDirectionId: "d1",
  chunks: [{ id: "c1", sourceId: "s1", text: "Teams recover two days.", startOffset: 0, endOffset: 23 }],
  understanding: { schemaVersion: 1 as const, themes: [{ title: "Speed", summary: "Faster", claims: [{ statement: "Faster", evidenceState: "supported" as const, evidence: [{ sourceId: "s1", chunkId: "c1", quote: "Teams recover two days." }], userInputIds: [] }] }], gaps: [], nextQuestion: { question: "Who decides?", whyItMatters: "Focus", relatedThemeIndexes: [0] } },
  positioning: { schemaVersion: 1 as const, understandingVersionId: "u1", originalFraming: { title: "Original framing" as const, coreMessage: "Old" }, directions: [{ id: "d1", title: "Proof", coreMessage: "Recover time", from: "Slow", to: "Fast", tradeoff: "Narrow", excludes: ["Breadth"], evidence: [{ sourceId: "s1", chunkId: "c1", quote: "Teams recover two days." }], userInputIds: [] }, { id: "d2", title: "Decision", coreMessage: "Decide", from: "Browse", to: "Choose", tradeoff: "Direct", excludes: ["Detail"], evidence: [{ sourceId: "s1", chunkId: "c1", quote: "Teams recover two days." }], userInputIds: [] }] },
};

describe("deck runner", () => {
  it("builds the fixed grounded five-page draft", () => {
    const result = buildDeterministicDeck(input);
    expect(result.pages.map((page) => page.kind)).toEqual(["positioning", "shift", "rationale", "evidence", "open_questions"]);
  });

  it("validates a mocked Responses API result against upstream versions and exact evidence", async () => {
    const proposal = buildDeterministicDeck(input);
    let requestBody: Record<string, unknown> | undefined;
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(proposal) }] }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await new ResponsesDeckRunner({ apiKey: "test-key", model: "pinned-model", baseURL: "https://example.test/v1/", fetch: mockFetch }).run(input);
    expect(result.pages).toHaveLength(5);
    expect(requestBody).toMatchObject({ model: "pinned-model", text: { format: { type: "json_schema", name: "pitchroom_deck_v1" } } });
  });

  it("rejects a mocked live deck aimed at stale upstream state", async () => {
    const proposal = { ...buildDeterministicDeck(input), positioningVersionId: "stale" };
    const mockFetch = (async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(proposal) }] }] }), { status: 200 })) as typeof fetch;
    await expect(new ResponsesDeckRunner({ apiKey: "test-key", model: "pinned-model", baseURL: "https://example.test/v1", fetch: mockFetch }).run(input)).rejects.toThrow("stale upstream versions");
  });
});
