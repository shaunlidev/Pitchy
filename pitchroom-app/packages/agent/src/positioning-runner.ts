import { PitchroomError, positioningProposalV1Schema, validatePositioningEvidence, type PositioningProposalV1, type SourceChunk, type UnderstandingProposalV1 } from "@pitchroom/domain";

export type PositioningAgentInput = {
  understandingVersionId: string;
  understanding: UnderstandingProposalV1;
  chunks: SourceChunk[];
};

export type PositioningAgentRunner = {
  run(input: PositioningAgentInput): Promise<PositioningProposalV1>;
};

export function buildDeterministicPositioning(input: PositioningAgentInput): PositioningProposalV1 {
  const evidencedClaims = input.understanding.themes.flatMap((theme) => theme.claims).filter((claim) => claim.evidence.length > 0);
  const first = evidencedClaims[0];
  if (!first) throw new Error("Positioning needs at least one source-supported claim.");
  const second = evidencedClaims[1] ?? first;
  const original = input.understanding.themes.map((theme) => theme.summary).join(" ");
  const evidenceOne = first.evidence.slice(0, 2);
  const evidenceTwo = second.evidence.slice(0, 2);
  const proposal = positioningProposalV1Schema.parse({
    schemaVersion: 1,
    understandingVersionId: input.understandingVersionId,
    originalFraming: { title: "Original framing", coreMessage: original },
    directions: [
      {
        id: "evidence-first",
        title: "Evidence first",
        coreMessage: first.statement,
        from: original,
        to: `A story led by the strongest supported signal: ${first.statement}`,
        tradeoff: "This direction prioritizes what the material can prove and may underplay a broader ambition.",
        excludes: ["Claims that are not supported by the current material"],
        evidence: evidenceOne,
        userInputIds: first.userInputIds,
      },
      {
        id: "decision-first",
        title: "Decision first",
        coreMessage: input.understanding.nextQuestion.question,
        from: original,
        to: `A story organized around the decision still to be made: ${input.understanding.nextQuestion.question}`,
        tradeoff: "This direction creates urgency but keeps an unresolved decision visibly open.",
        excludes: ["A comprehensive account of every theme"],
        evidence: evidenceTwo,
        userInputIds: second.userInputIds,
      },
    ],
  });
  validatePositioningEvidence(proposal, input.chunks);
  return proposal;
}

export class DeterministicPositioningRunner implements PositioningAgentRunner {
  async run(input: PositioningAgentInput) { return buildDeterministicPositioning(input); }
}

const positioningJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "understandingVersionId", "originalFraming", "directions"],
  properties: {
    schemaVersion: { const: 1 },
    understandingVersionId: { type: "string" },
    originalFraming: { type: "object", additionalProperties: false, required: ["title", "coreMessage"], properties: { title: { const: "Original framing" }, coreMessage: { type: "string" } } },
    directions: { type: "array", minItems: 2, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["id", "title", "coreMessage", "from", "to", "tradeoff", "excludes", "evidence", "userInputIds"], properties: {
      id: { type: "string" }, title: { type: "string" }, coreMessage: { type: "string" }, from: { type: "string" }, to: { type: "string" }, tradeoff: { type: "string" }, excludes: { type: "array", items: { type: "string" } }, judgmentNote: { type: "string" },
      evidence: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["sourceId", "chunkId", "quote"], properties: { sourceId: { type: "string" }, chunkId: { type: "string" }, quote: { type: "string" } } } },
      userInputIds: { type: "array", items: { type: "string" } },
    } } },
  },
} as const;

function responseText(payload: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }) {
  return (payload.output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
}

export class ResponsesPositioningRunner implements PositioningAgentRunner {
  constructor(private readonly config: { apiKey: string; model: string; baseURL: string; fetch?: typeof fetch }, private readonly timeoutMs = 60_000) {}
  async run(input: PositioningAgentInput) {
    const request = this.config.fetch ?? fetch;
    const response = await request(`${this.config.baseURL.replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        input: [{ role: "system", content: "Create 2 or 3 distinct positioning directions from the accepted understanding. Preserve the original framing. Every direction must cite only exact quotes from supplied chunks. Make tradeoffs and exclusions explicit. Return only the requested JSON." }, { role: "user", content: JSON.stringify(input) }],
        text: { format: { type: "json_schema", name: "pitchroom_positioning_v1", schema: positioningJsonSchema } },
        max_output_tokens: 5_000,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json() as { status?: string; error?: { message?: string }; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
    if (!response.ok || payload.status === "failed") throw new PitchroomError("PROPOSAL_REJECTED", payload.error?.message ?? `Positioning request failed with HTTP ${response.status}.`);
    const text = responseText(payload);
    if (!text) throw new PitchroomError("PROPOSAL_REJECTED", "The model returned no positioning JSON.");
    let raw: unknown;
    try { raw = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw new PitchroomError("PROPOSAL_REJECTED", "The model returned invalid positioning JSON."); }
    const proposal = positioningProposalV1Schema.parse(raw);
    if (proposal.understandingVersionId !== input.understandingVersionId) throw new PitchroomError("PROPOSAL_REJECTED", "Positioning targeted a stale understanding version.");
    validatePositioningEvidence(proposal, input.chunks);
    return proposal;
  }
}

export function createLivePositioningRunner(config: { apiKey?: string; model?: string; baseURL?: string }) {
  if (!config.apiKey) throw new PitchroomError("INVALID_INPUT", "OPENAI_API_KEY is required for live positioning.");
  if (!config.model) throw new PitchroomError("INVALID_INPUT", "OPENAI_MODEL must be pinned for live positioning.");
  return new ResponsesPositioningRunner({ apiKey: config.apiKey, model: config.model, baseURL: config.baseURL ?? "https://api.openai.com/v1" });
}
