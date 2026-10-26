import { describe, expect, it } from "vitest";
import { deckProposalV1Schema, validateDeckEvidence } from "./deck";

const evidence = { sourceId: "source-1", chunkId: "chunk-1", quote: "proof" };
const base = { schemaVersion: 1 as const, understandingVersionId: "understanding-1", positioningVersionId: "positioning-1", appliedDirectionId: "direction-1", pages: [
  { id: "p1", kind: "positioning", title: "Positioning", body: "Promise", evidence: [evidence], userInputIds: [], openQuestions: [] },
  { id: "p2", kind: "shift", title: "Shift", body: "From to", evidence: [evidence], userInputIds: [], openQuestions: [] },
  { id: "p3", kind: "rationale", title: "Rationale", body: "Reason", evidence: [evidence], userInputIds: [], openQuestions: [] },
  { id: "p4", kind: "evidence", title: "Evidence", body: "Proof", evidence: [evidence], userInputIds: [], openQuestions: [] },
  { id: "p5", kind: "open_questions", title: "Open questions", body: "Still open", evidence: [], userInputIds: [], openQuestions: ["Who decides?"] },
] };

describe("deck contract", () => {
  it("requires the fixed five-page discussion order", () => expect(deckProposalV1Schema.parse(base).pages).toHaveLength(5));
  it("rejects a missing page role", () => expect(() => deckProposalV1Schema.parse({ ...base, pages: base.pages.slice(0, 4) })).toThrow());
  it("validates exact source evidence", () => {
    const proposal = deckProposalV1Schema.parse(base);
    expect(() => validateDeckEvidence(proposal, [{ id: "chunk-1", sourceId: "source-1", text: "the proof is here", startOffset: 0, endOffset: 17 }])).not.toThrow();
    expect(() => validateDeckEvidence(proposal, [{ id: "chunk-1", sourceId: "source-1", text: "missing", startOffset: 0, endOffset: 7 }])).toThrow("not present");
  });
});
