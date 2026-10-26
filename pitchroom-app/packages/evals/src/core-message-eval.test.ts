import { describe, expect, it } from "vitest";
import { apidogCandidateOutputs } from "./core-message-apidog-cases";
import {
  evaluateCoreMessageRegression,
  precheckCoreMessage,
} from "./core-message-eval";

describe("Apidog core-message deterministic precheck", () => {
  for (const candidate of apidogCandidateOutputs) {
    it(`classifies ${candidate.id} as ${candidate.expected}`, () => {
      const result = evaluateCoreMessageRegression(candidate);
      expect(result.matchedExpectation, JSON.stringify(result, null, 2)).toBe(true);
    });
  }

  it("does not promote a structurally strong answer into human acceptance", () => {
    const result = precheckCoreMessage(
      "Change the API specification once. Keep documentation, mocks, requests, and tests aligned without manually copying changes across separate tools.",
    );

    expect(result).toMatchObject({
      classification: "strong",
      eligibleForHumanReview: true,
      hardFailures: [],
    });
  });

  it("hard-fails automatic production-code synchronization", () => {
    const result = precheckCoreMessage(
      "The API contract keeps docs and tests aligned while application code updates automatically.",
    );

    expect(result.classification).toBe("hard_fail");
    expect(result.eligibleForHumanReview).toBe(false);
    expect(result.hardFailures).toContain(
      "automatic_external_implementation_mutation",
    );
  });
});

