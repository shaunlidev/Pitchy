export type PitchroomErrorCode =
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BUDGET_EXCEEDED"
  | "CANCELLED"
  | "PROPOSAL_REJECTED"
  | "PERSISTENCE_ERROR";

export class PitchroomError extends Error {
  constructor(
    readonly code: PitchroomErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PitchroomError";
  }
}
