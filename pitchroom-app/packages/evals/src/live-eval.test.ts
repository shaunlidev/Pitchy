import { describe, expect, it } from "vitest";
import { initialEvalCases } from "./index";
import { selectLiveEvalCases } from "./live-eval";

describe("live eval selection", () => {
  it("uses a five-category smoke gate before the full model set", () => {
    const smoke = selectLiveEvalCases(initialEvalCases, "smoke");
    expect(smoke).toHaveLength(5);
    expect(smoke.map((item) => item.category)).toEqual(["supported", "missing", "conflicting", "prompt_injection", "long_material"]);
  });

  it("keeps user correction in the deterministic workflow gate", () => {
    expect(selectLiveEvalCases(initialEvalCases, "all").some((item) => item.category === "user_correction")).toBe(false);
  });
});
