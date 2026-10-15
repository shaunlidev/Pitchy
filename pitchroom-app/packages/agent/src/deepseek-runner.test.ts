import { describe, expect, it, vi } from "vitest";
import type { ToolRepository } from "@pitchroom/domain";
import { DeepSeekUnderstandingRunner, deepSeekOutputJsonSchema, parseDeepSeekJson } from "./deepseek-runner";

const chunk = { id: "source-1:chunk:0", sourceId: "source-1", text: "Revenue grew 40 percent.", startOffset: 0, endOffset: 24 };
const repository: ToolRepository = {
  async listSources() { return [{ id: "source-1", projectId: "project-1", name: "brief.md", mediaType: "text/markdown", contentHash: "hash", chunks: [chunk] }]; },
  async getSource() { return (await this.listSources("project-1"))[0]; },
  async getChunk() { return chunk; },
};

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("DeepSeek Responses adapter", () => {
  it("extracts a fenced JSON object", () => expect(parseDeepSeekJson("```json\n{\"ok\":true}\n```" )).toEqual({ ok: true }));

  it("closes every object and requires every declared property", () => {
    const visit = (schema: unknown): void => {
      if (!schema || typeof schema !== "object") return;
      const node = schema as { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown; items?: unknown; anyOf?: unknown[] };
      if (node.type === "object") {
        expect(node.additionalProperties).toBe(false);
        expect(node.required?.sort()).toEqual(Object.keys(node.properties ?? {}).sort());
        Object.values(node.properties ?? {}).forEach(visit);
      }
      if (node.type === "array") visit(node.items);
      node.anyOf?.forEach(visit);
    };
    visit(deepSeekOutputJsonSchema);
  });

  it("executes observable tools before accepting validated JSON", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: "completed", output: [{ type: "function_call", call_id: "1", name: "list_sources", arguments: "{}" }] }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", output: [{ type: "function_call", call_id: "2", name: "read_chunk", arguments: JSON.stringify({ chunkId: chunk.id }) }] }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", usage: { total_tokens: 42 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ proposal: { schemaVersion: 1, themes: [{ title: "Growth", summary: "Revenue grew.", claims: [{ statement: "Revenue grew 40 percent.", evidenceState: "supported", evidence: [{ sourceId: chunk.sourceId, chunkId: chunk.id, quote: chunk.text }], userInputIds: [] }] }], gaps: [], nextQuestion: { question: "What drove growth?", whyItMatters: "It explains the result.", relatedThemeIndexes: [0] } }, publicSummary: "One supported growth claim." }) }] }] }));
    const runner = new DeepSeekUnderstandingRunner(repository, { apiKey: "key", model: "deepseek-flash", baseURL: "https://api.deepseek.com", fetch: fetchMock });
    const result = await runner.run({ projectId: "project-1", chunks: [chunk] });
    expect(result.proposal.themes[0]?.claims[0]?.evidenceState).toBe("supported");
    expect(result.trace?.map((event) => event.type)).toEqual(["tool_called", "tool_succeeded", "tool_called", "tool_succeeded"]);
    expect(result.metrics).toMatchObject({ provider: "deepseek-responses", toolCallCount: 2 });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      tool_choice: "auto",
      text: { format: { type: "json_schema", name: "pitchroom_understanding_v1" } },
    });
  });

  it("rejects a final answer that skipped reading evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] }));
    const runner = new DeepSeekUnderstandingRunner(repository, { apiKey: "key", model: "deepseek-flash", baseURL: "https://api.deepseek.com", fetch: fetchMock });
    await expect(runner.run({ projectId: "project-1", chunks: [chunk] })).rejects.toThrow("before reading source evidence");
  });

  it("preserves completed tool events when final validation fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: "completed", output: [{ type: "function_call", call_id: "1", name: "read_chunk", arguments: JSON.stringify({ chunkId: chunk.id }) }] }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] }));
    const runner = new DeepSeekUnderstandingRunner(repository, { apiKey: "key", model: "deepseek-flash", baseURL: "https://api.deepseek.com", fetch: fetchMock });
    try {
      await runner.run({ projectId: "project-1", chunks: [chunk] });
      throw new Error("Expected validation failure");
    } catch (error) {
      expect((error as { trace?: unknown[] }).trace).toHaveLength(2);
    }
  });
});
