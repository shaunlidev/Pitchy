import { describe, expect, it } from "vitest";
import { evaluateRubric, gradeProposal, initialEvalCases, understandingEvalCaseSchema } from "./index";

const chunks = [{ id: "chunk", sourceId: "source", text: "Revenue grew 40 percent in 2026.", startOffset: 0, endOffset: 35 }];
const proposal = {
  schemaVersion: 1 as const,
  themes: [{ title: "Growth", summary: "Growth", claims: [{ statement: "Revenue grew 40 percent.", evidenceState: "supported" as const, evidence: [{ sourceId: "source", chunkId: "chunk", quote: "Revenue grew 40 percent" }], userInputIds: [] }] }],
  gaps: [],
  nextQuestion: { question: "What drove growth?", whyItMatters: "Tests durability", relatedThemeIndexes: [0] },
};

describe("offline evaluation harness", () => {
  it("ships at least 15 valid initial cases with critical coverage", () => {
    expect(initialEvalCases.length).toBeGreaterThanOrEqual(15);
    expect(initialEvalCases.every((item) => understandingEvalCaseSchema.safeParse(item).success)).toBe(true);
    expect(new Set(initialEvalCases.map((item) => item.category)).size).toBeGreaterThanOrEqual(9);
    expect(initialEvalCases.filter((item) => item.critical).length).toBeGreaterThanOrEqual(8);
  });

  it("passes a grounded result", () => {
    const grade = gradeProposal({ evalCase: initialEvalCases[0]!, proposal, chunks, terminalPhase: "review_required", stepCount: 3, maxSteps: 8 });
    expect(grade.passed).toBe(true);
  });

  it("catches fabricated evidence and budget violations", () => {
    const bad = structuredClone(proposal);
    bad.themes[0]!.claims[0]!.evidence[0]!.quote = "not in source";
    const grade = gradeProposal({ evalCase: initialEvalCases[0]!, proposal: bad, chunks, terminalPhase: "failed", stepCount: 9, maxSteps: 8 });
    expect(grade.passed).toBe(false);
    expect(grade.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "evidence_valid", passed: false }),
      expect.objectContaining({ name: "terminal_phase", passed: false }),
      expect.objectContaining({ name: "within_budget", passed: false }),
    ]));
  });

  it("keeps human rubric review as a separate threshold gate", () => {
    expect(evaluateRubric([])).toMatchObject({ passed: false, failures: ["missing_scores"] });
    const strong = { groundedness: 0.96, coverage: 0.85, questionUsefulness: 0.84, themeDistinctness: 0.8, uncertaintyHonesty: 0.95, userControl: 1, traceability: 1, notes: "Reviewed against source.", reviewer: "human" };
    expect(evaluateRubric([strong]).passed).toBe(true);
    expect(evaluateRubric([{ ...strong, groundedness: 0.7 }])).toMatchObject({ passed: false, failures: expect.arrayContaining(["groundedness", "groundedness_critical_case"]) });
  });
});
