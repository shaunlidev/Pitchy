import { describe, expect, it } from "vitest";
import {
  ProposalEvidenceError,
  understandingProposalV1Schema,
  validateProposalEvidence,
} from "./understanding";

const chunks = [
  {
    id: "chunk-1",
    sourceId: "source-1",
    text: "Customers replace ageing equipment before the summer peak.",
    startOffset: 0,
    endOffset: 58,
  },
];

const validProposal = {
  schemaVersion: 1 as const,
  themes: [
    {
      title: "Buying moment",
      summary: "Replacement is tied to seasonal operating risk.",
      claims: [
        {
          statement: "Customers replace equipment before the summer peak.",
          evidenceState: "supported" as const,
          evidence: [
            {
              sourceId: "source-1",
              chunkId: "chunk-1",
              quote: "before the summer peak",
            },
          ],
          userInputIds: [],
        },
      ],
    },
  ],
  gaps: [],
  nextQuestion: {
    question: "What event makes replacement urgent?",
    whyItMatters: "It determines the most credible buying trigger.",
    relatedThemeIndexes: [0],
  },
};

describe("UnderstandingProposalV1", () => {
  it("accepts a source-grounded proposal", () => {
    const proposal = understandingProposalV1Schema.parse(validProposal);
    expect(() => validateProposalEvidence(proposal, chunks)).not.toThrow();
  });

  it("rejects a supported claim without evidence", () => {
    const proposal: Record<string, any> = structuredClone(validProposal);
    proposal.themes[0].claims[0].evidence = [];
    expect(() => understandingProposalV1Schema.parse(proposal)).toThrow();
  });

  it("rejects a quote that is not in the referenced chunk", () => {
    const proposal = structuredClone(validProposal);
    proposal.themes[0].claims[0].evidence[0].quote = "invented quote";
    const parsed = understandingProposalV1Schema.parse(proposal);
    expect(() => validateProposalEvidence(parsed, chunks)).toThrow(
      ProposalEvidenceError,
    );
  });

  it("requires distinct sources for a conflicting claim", () => {
    const proposal: Record<string, any> = structuredClone(validProposal);
    proposal.themes[0].claims[0] = {
      statement: "Revenue differs.",
      evidenceState: "conflicting",
      evidence: [
        { sourceId: "source-1", chunkId: "chunk-1", quote: "Customers replace" },
        { sourceId: "source-1", chunkId: "chunk-2", quote: "summer peak" },
      ],
      userInputIds: [],
    };
    expect(understandingProposalV1Schema.safeParse(proposal).success).toBe(false);
  });
});
