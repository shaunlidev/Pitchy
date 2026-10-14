import { describe, expect, it } from "vitest";
import { executeAgentTool, type SourceRecord, type ToolRepository } from "./tools";

const records: SourceRecord[] = [
  {
    id: "source",
    projectId: "project",
    name: "source.txt",
    mediaType: "text/plain",
    contentHash: "hash",
    chunks: [
      { id: "b", sourceId: "source", text: "alpha beta", startOffset: 0, endOffset: 10 },
      { id: "a", sourceId: "source", text: "alpha alpha", startOffset: 10, endOffset: 21 },
    ],
  },
];
const repository: ToolRepository = {
  async listSources(projectId) { return records.filter((record) => record.projectId === projectId); },
  async getSource(projectId, sourceId) { return records.find((record) => record.projectId === projectId && record.id === sourceId); },
  async getChunk(projectId, chunkId) { return records.find((record) => record.projectId === projectId)?.chunks.find((chunk) => chunk.id === chunkId); },
};

describe("agent tools", () => {
  it("ranks lexical matches deterministically", async () => {
    const result = await executeAgentTool("project", { name: "search_chunks", arguments: { query: "alpha", limit: 2 } }, repository);
    expect(result).toMatchObject([{ id: "a", score: 2 }, { id: "b", score: 1 }]);
  });

  it("does not expose another project's source", async () => {
    await expect(executeAgentTool("other", { name: "read_chunk", arguments: { chunkId: "a" } }, repository)).rejects.toThrow();
  });
});
