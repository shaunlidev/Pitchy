import { outputLanguageInstruction, outputLanguage } from "./output-language";
import { coreMessageJsonSchema, coreMessageSystemPrompt, parseCoreMessageProposal, type CoreMessageProposalV2 } from "./core-message-contract";
import { activeUnderstanding, PitchroomError, positioningProposalV1Schema, validatePositioningEvidence, type PositioningProposalV1, type SourceChunk, type UnderstandingProposalV1 } from "@pitchroom/domain";

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
    originalFraming: { title: "Original framing", coreMessage: original, origin: "accepted_understanding" },
    directions: [
      {
        id: "evidence-first",
        lens: "mechanism",
        title: "Evidence first",
        audience: "The audience named in the accepted understanding",
        positioningThesis: `Lead with the strongest supported product behavior: ${first.statement}`,
        mechanism: first.statement,
        humanTension: "The audience needs a claim it can inspect before accepting a broader promise.",
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
        lens: "human_tension",
        title: "Decision first",
        audience: "The person accountable for the unresolved decision",
        positioningThesis: `Turn the unresolved decision into the story's organizing tension: ${input.understanding.nextQuestion.question}`,
        mechanism: "The working story keeps the unresolved decision visible beside supporting material.",
        humanTension: "The decision owner needs to move forward without pretending uncertainty is resolved.",
        coreMessage: input.understanding.nextQuestion.question,
        from: original,
        to: `A story organized around the decision still to be made: ${input.understanding.nextQuestion.question}`,
        tradeoff: "This direction creates urgency but keeps an unresolved decision visibly open.",
        excludes: ["A comprehensive account of every theme"],
        evidence: evidenceTwo,
        userInputIds: second.userInputIds,
      },
    ],
    recommendation: {
      directionId: "evidence-first",
      judgment: "Lead with the mechanism direction because it is the strongest distinctive claim supported by the accepted material.",
      comparison: "The mechanism direction is more concrete and defensible; the human-tension direction creates urgency but depends on an unresolved question.",
      conditionsToReconsider: ["Prefer the human-tension direction if the decision owner confirms that unresolved uncertainty is the primary reason the audience seeks help."],
    },
  });
  validatePositioningEvidence(proposal, input.chunks);
  return proposal;
}

export class DeterministicPositioningRunner implements PositioningAgentRunner {
  async run(input: PositioningAgentInput) { return buildDeterministicPositioning(input); }
}

export function coreMessageToPositioning(proposal: CoreMessageProposalV2, input: PositioningAgentInput): PositioningProposalV1 {
  const cite = (e: {sourceId:string;quote:string}) => {
    const chunk = input.chunks.find(c=>c.sourceId===e.sourceId && c.text.includes(e.quote));
    if (!chunk) throw new PitchroomError("PROPOSAL_REJECTED", "Positioning quote must match one exact source chunk.");
    return {sourceId:e.sourceId,chunkId:chunk.id,quote:e.quote};
  };
  return positioningProposalV1Schema.parse({schemaVersion:1, understandingVersionId:input.understandingVersionId,
    originalFraming:{title:"Original framing",coreMessage:input.understanding.themes.map(t=>t.summary).join(" "),origin:"accepted_understanding"},
    directions:proposal.hypotheses.map(h=>({id:h.id,lens:h.lens,title:h.title,audience:h.audience,positioningThesis:h.positioningThesis,mechanism:h.mechanism,humanTension:h.audienceSituation,coreMessage:h.coreMessage,from:h.from,to:h.to,tradeoff:h.hiddenTradeoff,excludes:h.exclusions,evidence:h.supportingEvidence.map(cite),counterEvidence:h.counterEvidence.map(cite),unknowns:h.unknowns,emphasis:h.emphasis,audienceRecognition:h.audienceRecognition,humanPayoff:h.humanPayoff,userInputIds:[]})),
    recommendation:{directionId:proposal.recommendation.hypothesisId,judgment:proposal.recommendation.judgment,comparison:proposal.recommendation.comparison,conditionsToReconsider:proposal.recommendation.conditionsToReconsider}
  });
}

function responseText(payload: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }) {
  return (payload.output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
}

export class ResponsesPositioningRunner implements PositioningAgentRunner {
  constructor(private readonly config: { apiKey: string; model: string; baseURL: string; fetch?: typeof fetch }, private readonly timeoutMs = 60_000) {}
  async run(input: PositioningAgentInput) {
    input = { ...input, understanding: activeUnderstanding(input.understanding) };
    const deepSeek = new URL(this.config.baseURL).hostname === "api.deepseek.com";
    const request = this.config.fetch ?? fetch;
    const providerFailure = (phase: "response_headers" | "response_body") => (error: unknown): never => {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new PitchroomError("PROVIDER_TIMEOUT", "The positioning provider timed out. Your existing work was preserved; retry only when you are ready.", { stage: "positioning", phase, timeoutMs: this.timeoutMs });
      }
      throw error;
    };
    const response = await request(`${this.config.baseURL.replace(/\/+$/, "")}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        input: [{ role: "system", content: coreMessageSystemPrompt }, { role: "user", content: JSON.stringify({
          outputLanguage,
          languageInstruction: outputLanguageInstruction,
          originalFraming:input.understanding.themes.map(t=>t.summary).join(" "),
          originalFramingOrigin:{kind:"accepted_understanding",understandingVersionId:input.understandingVersionId,scope:"An accepted interpretation, not a client quotation. Original source wording is chosen explicitly outside model output."},
          sources:[...new Set(input.chunks.map(c=>c.sourceId))].map(id=>({id,authority:"Supplied project material; records are not automatically current or verified",material:input.chunks.filter(c=>c.sourceId===id).map(c=>c.text).join("\n"),evidenceBoundary:"Cite an exact quote within one chunk. Preserve uncertainty and source attribution."})),
          understanding:input.understanding,
          groundingPolicy:"Preserved claims record historical material, not necessarily current applicability. Respect summaryInterpretation groundingV4/legacy applicability, scope and attribution. User-reported requirements remain unverified; user_edited_unreviewed is not endorsed by original Agent reasoning. Never turn suggestions into requirements."
        }) }],
        text: { format: { type: "json_schema", name: "pitchroom_core_message_v2", schema: coreMessageJsonSchema } },
        max_output_tokens: deepSeek ? 16_000 : 5_000, ...(deepSeek ? { reasoning: { effort: "low" }, store: false } : {}),
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch(providerFailure("response_headers"));
    const payload = await response.json().catch(providerFailure("response_body")) as { status?: string; error?: { message?: string }; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
    if (!response.ok || payload.status === "failed") throw new PitchroomError("PROPOSAL_REJECTED", payload.error?.message ?? `Positioning request failed with HTTP ${response.status}.`);
    if (payload.status === "incomplete") throw new PitchroomError("PROPOSAL_REJECTED", "Provider output was incomplete (output limit or filter); no draft was applied.");
    const text = responseText(payload);
    if (!text) throw new PitchroomError("PROPOSAL_REJECTED", "The model returned no positioning JSON.");
    let raw: unknown;
    try { raw = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
    catch { throw new PitchroomError("PROPOSAL_REJECTED", "The model returned invalid positioning JSON."); }
    const sources=[...new Set(input.chunks.map(c=>c.sourceId))].map(id=>({id,authority:"Project source",url:"https://local.invalid",material:input.chunks.filter(c=>c.sourceId===id).map(c=>c.text).join("\n"),boundary:""}));
    const coreProposal = parseCoreMessageProposal(raw,sources);
    if (coreProposal.hypotheses.some((hypothesis) => /\p{Script=Han}/u.test(hypothesis.coreMessage))) {
      throw new PitchroomError("PROPOSAL_REJECTED", `Generated positioning slogans must use ${outputLanguage}, under the English-only product policy.`);
    }
    const proposal = coreMessageToPositioning(coreProposal,input);
    validatePositioningEvidence(proposal, input.chunks);
    return proposal;
  }
}

export function createLivePositioningRunner(config: { apiKey?: string; model?: string; baseURL?: string; fetch?: typeof fetch }) {
  if (!config.apiKey) throw new PitchroomError("INVALID_INPUT", "OPENAI_API_KEY is required for live positioning.");
  if (!config.model) throw new PitchroomError("INVALID_INPUT", "OPENAI_MODEL must be pinned for live positioning.");
  return new ResponsesPositioningRunner({ apiKey: config.apiKey, model: config.model, baseURL: config.baseURL ?? "https://api.openai.com/v1", fetch: config.fetch });
}
