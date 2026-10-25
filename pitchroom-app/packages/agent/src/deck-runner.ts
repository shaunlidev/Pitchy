import { outputLanguageInstruction } from "./output-language";
import { activeUnderstanding, DeckProposalV1, PitchroomError, deckPageKinds, deckProposalV1Schema, validateDeckEvidence, type PositioningProposalV1, type SourceChunk, type UnderstandingProposalV1 } from "@pitchroom/domain";

export type DeckAgentInput = {
  understandingVersionId: string;
  understanding: UnderstandingProposalV1;
  positioningVersionId: string;
  positioning: PositioningProposalV1;
  appliedDirectionId: string;
  chunks: SourceChunk[];
};
export type DeckAgentRunner = { run(input: DeckAgentInput): Promise<DeckProposalV1> };

export function buildDeterministicDeck(input: DeckAgentInput): DeckProposalV1 {
  const direction = input.appliedDirectionId === "original" ? undefined : input.positioning.directions.find((candidate) => candidate.id === input.appliedDirectionId);
  if (input.appliedDirectionId !== "original" && !direction) throw new PitchroomError("INVALID_INPUT", "The applied positioning direction is missing.");
  const fallback = input.positioning.directions[0];
  if (!fallback) throw new PitchroomError("INVALID_INPUT", "Deck generation needs source-grounded positioning.");
  const evidence = direction?.evidence ?? fallback.evidence;
  const core = direction?.coreMessage ?? input.positioning.originalFraming.coreMessage;
  const from = direction?.from ?? input.positioning.originalFraming.coreMessage;
  const to = direction?.to ?? input.positioning.originalFraming.coreMessage;
  const rationale = direction?.tradeoff ?? "The original framing is being retained explicitly.";
  const questions = [input.understanding.nextQuestion.question, ...input.understanding.gaps.map((gap) => gap.description)].filter(Boolean);
  const pages = [
    { id: "page-positioning", kind: "positioning", title: "Positioning", body: core, evidence, userInputIds: direction?.userInputIds ?? [], openQuestions: [] },
    { id: "page-shift", kind: "shift", title: "The shift", body: `From: ${from}\nTo: ${to}`, evidence, userInputIds: direction?.userInputIds ?? [], openQuestions: [] },
    { id: "page-rationale", kind: "rationale", title: "Why this direction", body: rationale, evidence, userInputIds: direction?.userInputIds ?? [], openQuestions: [] },
    { id: "page-evidence", kind: "evidence", title: "What supports it", body: evidence.map((item) => item.quote).join("\n\n"), evidence, userInputIds: direction?.userInputIds ?? [], openQuestions: [] },
    { id: "page-open-questions", kind: "open_questions", title: "What remains open", body: questions.join("\n"), evidence: [], userInputIds: [], openQuestions: questions },
  ];
  const proposal = deckProposalV1Schema.parse({ schemaVersion: 1, understandingVersionId: input.understandingVersionId, positioningVersionId: input.positioningVersionId, appliedDirectionId: input.appliedDirectionId, pages });
  validateDeckEvidence(proposal, input.chunks);
  return proposal;
}

export class DeterministicDeckRunner implements DeckAgentRunner { async run(input: DeckAgentInput) { return buildDeterministicDeck(input); } }

const pageSchema = { type: "object", additionalProperties: false, required: ["id", "kind", "title", "body", "evidence", "userInputIds", "openQuestions", "speakerNotes"], properties: { id: { type: "string" }, kind: { enum: deckPageKinds }, title: { type: "string" }, body: { type: "string" }, speakerNotes: { type: "string" }, evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["sourceId", "chunkId", "quote"], properties: { sourceId: { type: "string" }, chunkId: { type: "string" }, quote: { type: "string" } } } }, userInputIds: { type: "array", items: { type: "string" } }, openQuestions: { type: "array", items: { type: "string" } } } } as const;
const deckJsonSchema = { type: "object", additionalProperties: false, required: ["schemaVersion", "understandingVersionId", "positioningVersionId", "appliedDirectionId", "pages"], properties: { schemaVersion: { const: 1 }, understandingVersionId: { type: "string" }, positioningVersionId: { type: "string" }, appliedDirectionId: { type: "string" }, pages: { type: "array", minItems: 5, maxItems: 5, items: pageSchema } } } as const;
function responseText(payload: { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }) { return (payload.output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join(""); }

export class ResponsesDeckRunner implements DeckAgentRunner {
  constructor(private readonly config: { apiKey: string; model: string; baseURL: string; fetch?: typeof fetch }, private readonly timeoutMs = 60_000) {}
  async run(input: DeckAgentInput) {
    input = { ...input, understanding: activeUnderstanding(input.understanding) };
    const deepSeek = new URL(this.config.baseURL).hostname === "api.deepseek.com";
    const response = await (this.config.fetch ?? fetch)(`${this.config.baseURL.replace(/\/+$/, "")}/responses`, { method: "POST", headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: this.config.model, input: [{ role: "system", content: `${outputLanguageInstruction}\nCreate exactly five discussion-deck pages in this order: positioning, shift, rationale, evidence, open_questions. Write finished audience-facing slides, not advice about how a deck should be written. Never write 'the deck should', 'this slide should' or describe your generation process.
Keep each English title at most 12 words and each body at most 45 words. Use short sentences or up to three compact lines. Page 1 title MUST be the exact applied coreMessage (or exact originalFraming.coreMessage when original is applied). Do not rewrite or bury that message in a paragraph. If the explicitly applied original framing or human-edited headline exceeds 12 words, preserve it exactly; the title limit applies to newly generated titles. Give each page a different job: product promise; concrete before/after change; why this choice and its tradeoff; bounded evidence and its limitations; remaining decisions. Put longer qualification, provenance and explanatory detail in speakerNotes, not repeated on every slide. Unknowns must remain in openQuestions or speakerNotes; do not omit them to meet a word cap. On page 5 use a brief body and concise openQuestions rather than repeating the same list in both.
Stay consistent with the applied direction and current Understanding. A presentation's pilot ask constrains the discussion, not the value proposition on every page. Cite only exact supplied quotes. Preserve uncertainty, attribution, disputed claims and source limitations; do not invent outcomes. Material suggestions and user-reported targets must not become agreed requirements or achieved performance. Read summaryInterpretation.groundingV4 and legacy applicability: retained historical claims are not automatically current, and user_edited_unreviewed means the original Agent basis does not endorse the edited wording; material origin does not imply requirement. Resolve basisRefs against bases. Use English for generated prose; keep source quotes verbatim. Return only requested JSON.` }, { role: "user", content: JSON.stringify(input) }], text: { format: { type: "json_schema", name: "pitchroom_deck_v1", schema: deckJsonSchema } }, max_output_tokens: deepSeek ? 16_000 : 7_000, ...(deepSeek ? { reasoning: { effort: "low" }, store: false } : {}) }), signal: AbortSignal.timeout(this.timeoutMs) });
    const payload = await response.json() as { status?: string; error?: { message?: string }; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
    if (!response.ok || payload.status === "failed") throw new PitchroomError("PROPOSAL_REJECTED", payload.error?.message ?? `Deck request failed with HTTP ${response.status}.`);
    if (payload.status === "incomplete") throw new PitchroomError("PROPOSAL_REJECTED", "Provider output was incomplete (output limit or filter); no draft was applied.");
    const text = responseText(payload);
    let raw: unknown;
    try { raw = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new PitchroomError("PROPOSAL_REJECTED", "The model returned invalid deck JSON."); }
    const proposal = deckProposalV1Schema.parse(raw);
    if (proposal.understandingVersionId !== input.understandingVersionId || proposal.positioningVersionId !== input.positioningVersionId || proposal.appliedDirectionId !== input.appliedDirectionId) throw new PitchroomError("PROPOSAL_REJECTED", "Deck targeted stale upstream versions.");
    const direction = input.positioning.directions.find(d=>d.id===input.appliedDirectionId);
    const core = input.appliedDirectionId === "original" ? input.positioning.originalFraming.coreMessage : direction?.coreMessage;
    if (proposal.pages[0]!.title !== core) throw new PitchroomError("PROPOSAL_REJECTED", "Deck lead headline must preserve the exact applied core message.");
    for (const [index,page] of proposal.pages.entries()) {
      if (page.speakerNotes === undefined) throw new PitchroomError("PROPOSAL_REJECTED", "Generated slides must retain inspectable speaker notes.");
      if (page.body.trim().split(/\s+/).length > 45 || (index>0 && page.title.trim().split(/\s+/).length > 12)) throw new PitchroomError("PROPOSAL_REJECTED", "Generated slides exceeded the concise presentation contract.");
      if (/the deck should|this slide should/i.test(page.body)) throw new PitchroomError("PROPOSAL_REJECTED", "Generated slides must address the audience, not describe the writing process.");
    }
    validateDeckEvidence(proposal, input.chunks);
    return proposal;
  }
}

export function createLiveDeckRunner(config: { apiKey?: string; model?: string; baseURL?: string }) {
  if (!config.apiKey) throw new PitchroomError("INVALID_INPUT", "OPENAI_API_KEY is required for live deck generation.");
  if (!config.model) throw new PitchroomError("INVALID_INPUT", "OPENAI_MODEL must be pinned for live deck generation.");
  return new ResponsesDeckRunner({ apiKey: config.apiKey, model: config.model, baseURL: config.baseURL ?? "https://api.openai.com/v1" });
}
