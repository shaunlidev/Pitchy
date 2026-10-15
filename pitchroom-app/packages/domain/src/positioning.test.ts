import { describe, expect, it } from "vitest";
import { positioningProposalV1Schema, validatePositioningEvidence } from "./positioning";

const chunk = { id: "chunk-1", sourceId: "source-1", text: "Teams shorten preparation by two days.", startOffset: 0, endOffset: 39 };
const direction = { id: "evidence-first", title: "Evidence first", coreMessage: "Recover two days.", from: "Presentation help", to: "Faster preparation", tradeoff: "Leads with efficiency, not craft.", excludes: ["Broad transformation"], evidence: [{ sourceId: chunk.sourceId, chunkId: chunk.id, quote: "shorten preparation by two days" }], userInputIds: [] };

describe("positioning proposal", () => {
  it("requires at least two directions and verifies exact quotes", () => {
    const proposal = positioningProposalV1Schema.parse({ schemaVersion: 1, understandingVersionId: "version-1", originalFraming: { title: "Original framing", coreMessage: "Presentation help" }, directions: [direction, { ...direction, id: "decision-first", title: "Decision first" }] });
    expect(() => validatePositioningEvidence(proposal, [chunk])).not.toThrow();
    expect(() => validatePositioningEvidence({ ...proposal, directions: [{ ...direction, evidence: [{ ...direction.evidence[0]!, quote: "invented" }] }, proposal.directions[1]!] }, [chunk])).toThrow(/not present/);
  });
});
