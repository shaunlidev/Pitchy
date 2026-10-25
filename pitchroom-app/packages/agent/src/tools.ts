import { z } from "zod";
import { PitchroomError, type ToolRepository } from "@pitchroom/domain";
import { isInstructionLikeSourceText, quarantineChunkForAgent } from "./prompt-safety";
export type { SourceRecord, ToolRepository } from "@pitchroom/domain";

export const toolCallSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("list_sources"), arguments: z.object({}) }),
  z.object({
    name: z.literal("list_chunks"),
    arguments: z.object({ sourceId: z.string().min(1), cursor: z.number().int().nonnegative().default(0) }),
  }),
  z.object({ name: z.literal("read_chunk"), arguments: z.object({ chunkId: z.string().min(1) }) }),
  z.object({
    name: z.literal("search_chunks"),
    arguments: z.object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(20).default(5) }),
  }),
]);

export type AgentToolCall = z.infer<typeof toolCallSchema>;

function scoreText(text: string, query: string): number {
  const normalizedText = text.toLocaleLowerCase("en-US");
  const terms = [...new Set(query.toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean))];
  return terms.reduce((total, term) => {
    let score = 0;
    let cursor = 0;
    while ((cursor = normalizedText.indexOf(term, cursor)) !== -1) {
      score += 1;
      cursor += term.length;
    }
    return total + score;
  }, 0);
}

export async function executeAgentTool(
  projectId: string,
  rawCall: unknown,
  repository: ToolRepository,
): Promise<unknown> {
  const call = toolCallSchema.parse(rawCall);
  switch (call.name) {
    case "list_sources": {
      const sources = await repository.listSources(projectId);
      return sources.map(({ chunks, ...source }) => ({ ...source, chunkCount: chunks.length }));
    }
    case "list_chunks": {
      const source = await repository.getSource(projectId, call.arguments.sourceId);
      if (!source) throw new PitchroomError("NOT_FOUND", "Source was not found in this project.");
      const pageSize = 20;
      const items = source.chunks.slice(call.arguments.cursor, call.arguments.cursor + pageSize).map(
        ({ text, ...metadata }) => ({ ...metadata, characterCount: text.length }),
      );
      const nextCursor = call.arguments.cursor + items.length;
      return { items, nextCursor: nextCursor < source.chunks.length ? nextCursor : null };
    }
    case "read_chunk": {
      const chunk = await repository.getChunk(projectId, call.arguments.chunkId);
      if (!chunk) throw new PitchroomError("NOT_FOUND", "Chunk was not found in this project.");
      return quarantineChunkForAgent(chunk);
    }
    case "search_chunks": {
      const sources = await repository.listSources(projectId);
      return sources
        .flatMap((source) => source.chunks)
        .map((chunk) => ({ chunk, score: scoreText(chunk.text, call.arguments.query) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
        .slice(0, call.arguments.limit)
        .map(({ chunk, score }) => isInstructionLikeSourceText(chunk.text)
          ? { ...quarantineChunkForAgent(chunk), score }
          : { ...chunk, score });
    }
  }
}
