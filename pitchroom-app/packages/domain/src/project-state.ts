import { z } from "zod";
import { PitchroomError } from "./errors";

export const projectPhaseSchema = z.enum([
  "empty",
  "materials_ready",
  "reading",
  "structuring",
  "review_required",
  "accepted",
  "failed",
  "cancelled",
]);

export type ProjectPhase = z.infer<typeof projectPhaseSchema>;

const allowedTransitions: Record<ProjectPhase, readonly ProjectPhase[]> = {
  empty: ["materials_ready"],
  materials_ready: ["reading"],
  reading: ["structuring", "failed", "cancelled"],
  structuring: ["review_required", "failed", "cancelled"],
  review_required: ["structuring", "accepted"],
  accepted: [],
  failed: ["materials_ready", "reading"],
  cancelled: ["materials_ready"],
};

export function assertPhaseTransition(
  from: ProjectPhase,
  to: ProjectPhase,
): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new PitchroomError(
      "INVALID_TRANSITION",
      `Invalid project phase transition: ${from} -> ${to}`,
      { from, to },
    );
  }
}
