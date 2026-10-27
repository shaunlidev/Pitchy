import {readPositioning,type PositioningRecord} from "./positioning";
export type DownstreamArtifactKind = "generated" | "human_edited" | "external";
export type DownstreamSyncStatus = "synced" | "auto_update_available" | "needs_review" | "drift_only";

export function deriveDownstreamSyncStatus(input: {
  artifactKind: DownstreamArtifactKind;
  artifactCoreMessageVersionId?: string;
  currentCoreMessageVersionId: string;
}): DownstreamSyncStatus {
  if (input.artifactCoreMessageVersionId === input.currentCoreMessageVersionId) return "synced";
  if (input.artifactKind === "generated") return "auto_update_available";
  if (input.artifactKind === "human_edited") return "needs_review";
  return "drift_only";
}

export function appliedCoreMessage(record:PositioningRecord) {
  const applied=readPositioning(record).applied;
  return applied ? {versionId:applied.positioningId,directionId:applied.choice.id,text:applied.choice.text,decisionId:applied.decisionId} : undefined;
}
