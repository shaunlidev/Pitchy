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

export function appliedCoreMessage(input: {
  versionId: string;
  original: string;
  appliedDirectionId?: string | null;
  directions: Array<{ id: string; coreMessage: string }>;
}) {
  if (!input.appliedDirectionId) return undefined;
  return {
    versionId: input.versionId,
    directionId: input.appliedDirectionId,
    text: input.appliedDirectionId === "original" ? input.original : input.directions.find((direction) => direction.id === input.appliedDirectionId)?.coreMessage,
  };
}
