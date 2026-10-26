import { describe, expect, it } from "vitest";
import { coreMessageContractCases, coreMessageEvalContract, validateCoreMessageContractMatrix } from "./core-message-contract";

describe("core-message eval contract v2", () => {
  it("covers eight distinct product categories with two signals and a safety boundary", () => {
    expect(validateCoreMessageContractMatrix()).toMatchObject({ passed: true, caseCount: 8 });
    expect(new Set(coreMessageContractCases.map((item) => item.category)).size).toBe(8);
  });

  it("defines hard gates, a human rubric, and a finite repair stop", () => {
    expect(coreMessageEvalContract.hardGates).toContain("exactly_one_of_each_lens");
    expect(coreMessageEvalContract.hardGates).toContain("explicit_comparative_recommendation");
    expect(coreMessageEvalContract.humanRubric).toContain("choice_usefulness");
    expect(coreMessageEvalContract.stopRule).toContain("two evidence-led repairs");
  });
});
