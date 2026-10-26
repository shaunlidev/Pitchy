import type { UnderstandingProposalV1 } from "@pitchroom/domain";
import type { UnderstandingAgentInput, UnderstandingAgentResult, UnderstandingAgentRunner } from "./controller";

const sentence = (text: string) => (text.trim().match(/^(.+?[.!?。！？](?:\s|$)|.+$)/s)?.[1] ?? text).trim().slice(0, 360);
const firstToken = (text: string) => text.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/u)?.[0];

export function buildDeterministicUnderstanding(input: UnderstandingAgentInput): UnderstandingAgentResult {
  if (input.signal?.aborted) throw new Error("Run was cancelled.");
  const firstBySource = [...new Map(input.chunks.map((chunk) => [chunk.sourceId, chunk])).values()];
  if (firstBySource.length === 0) throw new Error("At least one source chunk is required.");
  const passages = firstBySource.map((chunk) => ({ chunk, quote: sentence(chunk.text) }));
  const hostile = passages.some(({ quote }) => /ignore (all |prior |previous )?instructions|system\s*:/i.test(quote));
  const conflict = !hostile && passages.length > 1 && passages[0]!.quote !== passages[1]!.quote && firstToken(passages[0]!.quote) === firstToken(passages[1]!.quote);

  const claims: UnderstandingProposalV1["themes"][number]["claims"] = hostile
    ? [{ statement: "A source contains instruction-like text; its requested assertion remains unknown.", evidenceState: "unknown", evidence: [], userInputIds: [] }]
    : conflict
      ? [{ statement: "The supplied sources report conflicting versions of the same subject.", evidenceState: "conflicting", evidence: passages.slice(0, 2).map(({ chunk, quote }) => ({ sourceId: chunk.sourceId, chunkId: chunk.id, quote })), userInputIds: [] }]
      : passages.map(({ chunk, quote }) => ({ statement: quote, evidenceState: "supported" as const, evidence: [{ sourceId: chunk.sourceId, chunkId: chunk.id, quote }], userInputIds: [] }));

  return {
    proposal: {
      schemaVersion: 1,
      themes: [{
        title: hostile ? "Source needs human review" : conflict ? "Conflicting source claims" : "Core material signals",
        summary: hostile ? "Instruction-like material remains untrusted source data." : conflict ? "Two sources require explicit resolution." : `${claims.length} directly supported signal${claims.length === 1 ? "" : "s"} found.`,
        claims,
      }],
      gaps: [{ description: "The material does not establish the audience's highest-priority decision.", whyItMatters: "The pitch needs a decision-relevant emphasis.", relatedSourceIds: firstBySource.map((chunk) => chunk.sourceId) }],
      nextQuestion: { question: conflict ? "Which source should be treated as current, and why?" : "What decision should this presentation help the audience make?", whyItMatters: conflict ? "The conflict cannot be resolved safely by the agent." : "It determines what evidence deserves emphasis.", relatedThemeIndexes: [0] },
    },
    publicSummary: hostile ? "Instruction-like material was isolated for review." : conflict ? "A source conflict needs human resolution." : `${claims.length} grounded signal${claims.length === 1 ? "" : "s"} and one explicit gap.`,
    trace: [
      { type: "tool_called", payload: { name: "list_sources" } },
      { type: "tool_succeeded", payload: { name: "list_sources", sourceCount: firstBySource.length } },
      ...firstBySource.flatMap((chunk) => [
        { type: "tool_called" as const, payload: { name: "read_chunk", chunkId: chunk.id } },
        { type: "tool_succeeded" as const, payload: { name: "read_chunk", chunkId: chunk.id, characterCount: chunk.text.length } },
      ]),
    ],
    metrics: { stepCount: 1, toolCallCount: firstBySource.length + 1, mode: "deterministic" },
  };
}

export class DeterministicUnderstandingRunner implements UnderstandingAgentRunner {
  async run(input: UnderstandingAgentInput): Promise<UnderstandingAgentResult> {
    const result = buildDeterministicUnderstanding(input);
    for (const event of result.trace ?? []) await input.onTrace?.(event);
    return result;
  }
}
