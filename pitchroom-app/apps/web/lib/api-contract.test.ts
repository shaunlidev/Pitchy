import { describe, expect, it } from "vitest";
import { errorEnvelopeSchema, workspaceCommandSchema, workspaceStateSchema } from "./api-contract";
import { readFixtureState } from "./fixture-store";

describe("workspace API contract", () => {
  it("accepts every command shape and rejects ambiguous input", () => {
    expect(workspaceCommandSchema.parse({ action: "run", commandId: "run-1" }).action).toBe("run");
    expect(workspaceCommandSchema.parse({ action: "add_material", name: "brief.md", mediaType: "text/markdown", text: "Evidence" }).action).toBe("add_material");
    expect(workspaceCommandSchema.parse({ action: "correct", expectedRevision: 1, themeIndex: 1, claimIndex: 2, text: "Corrected claim" }).action).toBe("correct");
    expect(workspaceCommandSchema.parse({ action: "adjust_positioning", expectedRevision: 2, directionId: "direction-1", mode: "headline", text: "Exact headline" }).action).toBe("adjust_positioning");
    expect(workspaceCommandSchema.parse({ action: "generate_deck", expectedRevision: 2 }).action).toBe("generate_deck");
    expect(workspaceCommandSchema.parse({ action: "edit_deck_page", deckId: "deck-1", expectedDeckVersion: 1, pageId: "page-1", title: "Title", body: "Body" }).action).toBe("edit_deck_page");
    expect(workspaceCommandSchema.safeParse({ action: "correct", expectedRevision: -1, themeIndex: 0, claimIndex: 0, text: "" }).success).toBe(false);
    expect(workspaceCommandSchema.safeParse({ action: "edit_deck_page", deckId: "deck-1", expectedDeckVersion: 0, pageId: "page-1", title: "", body: "Body" }).success).toBe(false);
    expect(workspaceCommandSchema.safeParse({ action: "unknown" }).success).toBe(false);
  });

  it("validates response and error envelopes", () => {
    expect(workspaceStateSchema.parse(readFixtureState()).project.phase).toBe("empty");
    expect(errorEnvelopeSchema.parse({ code: "CONFLICT", error: "stale", requestId: "request-1" }).code).toBe("CONFLICT");
  });
});
