import {
  PitchroomError,
  assertPhaseTransition,
  understandingProposalV1Schema,
  validateProposalEvidence,
  type ProjectPhase,
  type SourceChunk,
  type UnderstandingProposalV1,
} from "@pitchroom/domain";

export function validateAgentAuthorship(proposal: UnderstandingProposalV1): void {
  if (proposal.themes.some((theme) => theme.claims.some((claim) => claim.evidenceState === "user_asserted"))) {
    throw new PitchroomError("PROPOSAL_REJECTED", "An agent proposal cannot create user-attributed claims.");
  }
}

export type UnderstandingAgentInput = {
  projectId: string;
  chunks: SourceChunk[];
  signal?: AbortSignal;
};

export type UnderstandingAgentResult = {
  proposal: UnderstandingProposalV1;
  publicSummary: string;
  trace?: Array<{ type: "tool_called" | "tool_succeeded" | "tool_failed"; payload: Record<string, unknown> }>;
  metrics?: Record<string, unknown>;
};

export interface UnderstandingAgentRunner {
  run(input: UnderstandingAgentInput): Promise<UnderstandingAgentResult>;
}

export type UnderstandingRunOutcome = {
  phase: "review_required";
  proposal: UnderstandingProposalV1;
  publicSummary: string;
  trace: NonNullable<UnderstandingAgentResult["trace"]>;
  metrics?: Record<string, unknown>;
};

export async function runUnderstandingAgent(
  currentPhase: ProjectPhase,
  input: UnderstandingAgentInput,
  runner: UnderstandingAgentRunner,
): Promise<UnderstandingRunOutcome> {
  assertPhaseTransition(currentPhase, "reading");
  assertPhaseTransition("reading", "structuring");

  const result = await runner.run(input);
  const proposal = understandingProposalV1Schema.parse(result.proposal);
  validateAgentAuthorship(proposal);
  validateProposalEvidence(proposal, input.chunks);

  assertPhaseTransition("structuring", "review_required");
  return {
    phase: "review_required",
    proposal,
    publicSummary: result.publicSummary,
    trace: result.trace ?? [],
    metrics: result.metrics,
  };
}
