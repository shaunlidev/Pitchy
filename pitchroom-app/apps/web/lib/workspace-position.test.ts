import { beforeEach, expect, it } from "vitest";
import { acceptFixture, addFixtureMaterial, applyFixturePositioning, generateFixtureDeck, generateFixturePositioning, readFixtureState, resetFixtureState, runFixtureAgent } from "./fixture-store";
import { readWorkspacePosition, resolveWorkspacePosition, workspacePositionKey, type WorkspacePosition } from "./workspace-position";

beforeEach(() => resetFixtureState());
const saved: WorkspacePosition = { schemaVersion: 1, destination: "deck", understandingId: "old", overviewSelection: "gap:99", deckId: "missing", pageId: "missing" };

it("falls back from inaccessible destinations and removed versions without generating work", () => {
  const state = readFixtureState();
  const before = structuredClone(state);
  expect(resolveWorkspacePosition(state, saved)).toMatchObject({ destination: "materials", overviewSelection: "theme:0", deckId: undefined });
  expect(state).toEqual(before);
});

it("restores a saved historical Deck page and scopes the topic to its Understanding", () => {
  addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier prepares client presentations." });
  const review = runFixtureAgent(); acceptFixture(review.project.revision);
  generateFixturePositioning(); applyFixturePositioning("evidence-first", readFixtureState().project.revision);
  const state = generateFixtureDeck(readFixtureState().project.revision);
  const deck = state.deck!;
  const page = deck.proposal.pages[1]!;
  const position = resolveWorkspacePosition(state, { ...saved, understandingId: state.currentVersionId, overviewSelection: "gap:0", deckId: deck.id, pageId: page.id });
  expect(position).toMatchObject({ destination: "deck", overviewSelection: "gap:0", deckId: deck.id, pageId: page.id });
  expect(resolveWorkspacePosition(state, { ...position, understandingId: "superseded" }).overviewSelection).toBe("theme:0");
});

it("reads only the requested project's validated navigation identifiers", () => {
  const records = new Map([[workspacePositionKey("a"), JSON.stringify(saved)]]);
  const storage = { getItem: (key: string) => records.get(key) ?? null };
  expect(readWorkspacePosition(storage, "b")).toBeUndefined();
  expect(readWorkspacePosition(storage, "a")).toEqual(saved);
  records.set(workspacePositionKey("a"), JSON.stringify({ schemaVersion: 2, destination: "run_model" }));
  expect(readWorkspacePosition(storage, "a")).toBeUndefined();
});
