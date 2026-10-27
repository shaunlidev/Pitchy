import {positioningProposalV1Schema} from "./positioning";
import { describe, expect, it } from "vitest";
import { appliedCoreMessage, deriveDownstreamSyncStatus } from "./core-message-sync";

describe("applied core message single source of truth", () => {
  it("resolves only the explicitly applied direction", () => {
    expect(appliedCoreMessage({id:"positioning-v2",appliedDirectionId:"human",proposal:proposal()})).toEqual({ versionId: "positioning-v2", directionId: "human", text: "Shared before awkward.",decisionId:"legacy:positioning-v2:human" });
    expect(appliedCoreMessage({id:"positioning-v2",proposal:proposal()})).toBeUndefined();
  });

  it("routes downstream changes by ownership instead of overwriting everything", () => {
    expect(deriveDownstreamSyncStatus({ artifactKind: "generated", artifactCoreMessageVersionId: "v1", currentCoreMessageVersionId: "v2" })).toBe("auto_update_available");
    expect(deriveDownstreamSyncStatus({ artifactKind: "human_edited", artifactCoreMessageVersionId: "v1", currentCoreMessageVersionId: "v2" })).toBe("needs_review");
    expect(deriveDownstreamSyncStatus({ artifactKind: "external", artifactCoreMessageVersionId: "v1", currentCoreMessageVersionId: "v2" })).toBe("drift_only");
    expect(deriveDownstreamSyncStatus({ artifactKind: "human_edited", artifactCoreMessageVersionId: "v2", currentCoreMessageVersionId: "v2" })).toBe("synced");
  });
});

function proposal(){return positioningProposalV1Schema.parse({schemaVersion:1,understandingVersionId:"u",originalFraming:{title:"Original framing",coreMessage:"Original"},directions:["human","other"].map(id=>({id,title:id,coreMessage:"Shared before awkward.",from:"before",to:"after",tradeoff:"choice",excludes:[],evidence:[{sourceId:"s",chunkId:"c",quote:"source"}],userInputIds:[]}))});}
