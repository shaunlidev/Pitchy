import { describe, expect, it } from "vitest";
import { assertPhaseTransition } from "./project-state";

describe("project cancellation transitions", () => {
  it("allows active work to cancel and cancelled work to retry from materials", () => {
    expect(() => assertPhaseTransition("reading", "cancelled")).not.toThrow();
    expect(() => assertPhaseTransition("structuring", "cancelled")).not.toThrow();
    expect(() => assertPhaseTransition("cancelled", "materials_ready")).not.toThrow();
    expect(() => assertPhaseTransition("failed", "reading")).not.toThrow();
  });

  it("does not cancel an accepted understanding", () => {
    expect(() => assertPhaseTransition("accepted", "cancelled")).toThrow("Invalid project phase transition");
  });
});
