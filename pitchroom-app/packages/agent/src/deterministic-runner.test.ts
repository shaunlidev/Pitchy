import { describe, expect, it } from "vitest";
import { buildDeterministicUnderstanding } from "./deterministic-runner";

const chunk = (sourceId: string, text: string, index: number) => ({ id: `${sourceId}:chunk:${index}`, sourceId, text, startOffset: 0, endOffset: text.length });

describe("deterministic understanding runner", () => {
  it("reads the first passage from every source", () => {
    const result = buildDeterministicUnderstanding({ projectId: "project", chunks: [chunk("one", "Revenue increased.", 0), chunk("two", "Customers renewed.", 0)] });
    expect(result.proposal.themes[0]?.claims).toHaveLength(2);
    expect(result.proposal.themes[0]?.claims.map((claim) => claim.evidence[0]?.sourceId)).toEqual(["one", "two"]);
  });

  it("preserves a conflict across distinct sources", () => {
    const result = buildDeterministicUnderstanding({ projectId: "project", chunks: [chunk("one", "Revenue is $2M.", 0), chunk("two", "Revenue is $3M.", 0)] });
    const claim = result.proposal.themes[0]?.claims[0];
    expect(claim?.evidenceState).toBe("conflicting");
    expect(new Set(claim?.evidence.map((item) => item.sourceId)).size).toBe(2);
  });
});
