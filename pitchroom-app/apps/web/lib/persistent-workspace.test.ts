import { describe, expect, it } from "vitest";
import { reconstructSourceContent } from "./persistent-workspace";

describe("persistent workspace source reconstruction", () => {
  it("does not duplicate overlapping chunk text", () => {
    expect(reconstructSourceContent([
      { startOffset: 0, text: "abcdef" },
      { startOffset: 4, text: "efghij" },
    ])).toBe("abcdefghij");
  });

  it("is stable when chunks arrive out of order", () => {
    expect(reconstructSourceContent([
      { startOffset: 4, text: "efghij" },
      { startOffset: 0, text: "abcdef" },
    ])).toBe("abcdefghij");
  });
});
