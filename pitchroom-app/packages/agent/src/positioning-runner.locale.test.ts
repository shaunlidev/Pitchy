import { describe, expect, it } from "vitest";
import { coreMessageSystemPrompt } from "./core-message-contract";
import { coreMessageWireFixture } from "./presentation.testkit";
import { buildDeterministicPositioning, ResponsesPositioningRunner, type PositioningAgentInput } from "./positioning-runner";

const englishInput: PositioningAgentInput = {
  understandingVersionId: "accepted-understanding",
  chunks: [{ id: "chunk-1", sourceId: "source-1", text: "Show the quote behind every recommendation.", startOffset: 0, endOffset: 43 }],
  understanding: {
    schemaVersion: 1,
    themes: [{ title: "Evidence", summary: "Keep the original English framing.", claims: [{ statement: "Recommendations link to source quotes.", evidenceState: "supported", evidence: [{ sourceId: "source-1", chunkId: "chunk-1", quote: "Show the quote behind every recommendation." }], userInputIds: [] }] }],
    gaps: [],
    nextQuestion: { question: "What would make the trial successful?", whyItMatters: "The success measure remains open.", relatedThemeIndexes: [0] },
  },
};
const chineseInput: PositioningAgentInput = {
  ...englishInput,
  understanding: { ...englishInput.understanding, nextQuestion: { ...englishInput.understanding.nextQuestion, question: "用什么可观察的结果判断试用是否成功？" } },
};

function wireWithSlogans(slogans: [string, string]) {
  const wire = coreMessageWireFixture(buildDeterministicPositioning(englishInput));
  return { ...wire, hypotheses: wire.hypotheses.map((hypothesis, index) => ({ ...hypothesis, coreMessage: slogans[index] })) };
}

function runnerWithSlogans(slogans: [string, string], inspectRequest?: (body: unknown) => void) {
  const transport: typeof fetch = async (_url, init) => {
    inspectRequest?.(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(wireWithSlogans(slogans)) }] }] }), { status: 200 });
  };
  return new ResponsesPositioningRunner({ apiKey: "offline", model: "pinned-model", baseURL: "https://example.test/v1", fetch: transport });
}

describe("English-only positioning", () => {
  it.each([englishInput, chineseInput])("keeps generated slogans English regardless of saved question language", async (input) => {
    const before = structuredClone(input);
    const slogans: [string, string] = ["Show the quote behind every recommendation.", "When the client asks why, show the quote."];
    const result = await runnerWithSlogans(slogans, body => {
      expect(body).toMatchObject({ input: [
        { role: "system", content: coreMessageSystemPrompt },
        { role: "user", content: expect.stringContaining('"outputLanguage":"English"') },
      ] });
      expect(JSON.stringify(body)).toContain("Pitchroom is English-only");
    }).run(input);
    expect(result.directions.map(direction => direction.coreMessage)).toEqual(slogans);
    expect(result.originalFraming.coreMessage).toBe("Keep the original English framing.");
    expect(result.directions[0]?.evidence[0]?.quote).toBe("Show the quote behind every recommendation.");
    expect(input).toEqual(before);
  });

  it.each<[string, string]>([
    ["每条建议，都能回到原话。", "When the client asks why, show the quote."],
    ["每条建议，都能回到原话。", "客户问为什么，答案还在原话里。"],
  ])("rejects Chinese generated slogans even for a legacy Chinese question", async (first, second) => {
    await expect(runnerWithSlogans([first, second]).run(chineseInput)).rejects.toMatchObject({ code: "PROPOSAL_REJECTED" });
  });

  it("preserves Chinese original framing and quotations without translating the source", async () => {
    const quote = "每条建议都能回到原始记录。";
    const input: PositioningAgentInput = { ...chineseInput,
      chunks: [{ ...englishInput.chunks[0]!, text: quote, endOffset: quote.length }],
      understanding: { ...chineseInput.understanding, themes: [{ ...englishInput.understanding.themes[0]!, summary: "保留客户原话。" }] },
    };
    const wire = wireWithSlogans(["Show the quote behind every recommendation.", "When the client asks why, show the quote."]);
    wire.hypotheses.forEach(h => h.supportingEvidence.forEach(source => { source.quote = quote; }));
    const result = await new ResponsesPositioningRunner({ apiKey: "offline", model: "pinned", baseURL: "https://example.test/v1", fetch: async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(wire) }] }] })) }).run(input);
    expect(result.originalFraming.coreMessage).toBe("保留客户原话。");
    expect(result.directions[0]?.evidence[0]?.quote).toBe(quote);
  });
});
