import { describe, expect, it } from "vitest";
import { appliedCoreMessage, deriveDownstreamSyncStatus } from "./core-message-sync";

describe("applied core message single source of truth", () => {
  it("resolves only the explicitly applied direction", () => {
    expect(appliedCoreMessage({ versionId: "positioning-v2", original: "Original", appliedDirectionId: "human", directions: [{ id: "human", coreMessage: "Shared before awkward." }] })).toEqual({ versionId: "positioning-v2", directionId: "human", text: "Shared before awkward." });
    expect(appliedCoreMessage({ versionId: "positioning-v2", original: "Original", directions: [] })).toBeUndefined();
  });

  it("routes downstream changes by ownership instead of overwriting everything", () => {
    expect(deriveDownstreamSyncStatus({ artifactKind: "generated", artifactCoreMessageVersionId: "v1", currentCoreMessageVersionId: "v2" })).toBe("auto_update_available");
    expect(deriveDownstreamSyncStatus({ artifactKind: "human_edited", artifactCoreMessageVersionId: "v1", currentCoreMessageVersionId: "v2" })).toBe("needs_review");
    expect(deriveDownstreamSyncStatus({ artifactKind: "external", artifactCoreMessageVersionId: "v1", currentCoreMessageVersionId: "v2" })).toBe("drift_only");
    expect(deriveDownstreamSyncStatus({ artifactKind: "human_edited", artifactCoreMessageVersionId: "v2", currentCoreMessageVersionId: "v2" })).toBe("synced");
  });
});
