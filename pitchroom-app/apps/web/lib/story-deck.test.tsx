// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceView } from "./workspace-view";
import { resetFixtureState, addFixtureMaterial, runFixtureAgent, acceptFixture, generateFixturePositioning, applyFixturePositioning, proposeFixtureStory, decideFixtureStory, createFixtureStoryDeck } from "./fixture-store";

afterEach(cleanup);

it("renders the adopted emphasis in both single-page and complete Deck review", async () => {
  resetFixtureState();
  addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Reviewers check every claim against the saved source." });
  const understanding = runFixtureAgent();
  acceptFixture(understanding.project.revision);
  const positioning = generateFixturePositioning();
  applyFixturePositioning(positioning.positioning!.proposal.directions[0]!.id, positioning.project.revision);
  const preview = await proposeFixtureStory({ expected: { generation: 0, storyId: null }, commandId: "develop", request: { kind: "develop_direction" } });
  const proposal = preview.story!.proposals[0]!;
  const adopted = decideFixtureStory({ expected: proposal.baseHead, proposalId: proposal.id, commandId: "apply", decision: "apply" });
  const deck = createFixtureStoryDeck({ expected: adopted.story!.head, commandId: "deck" });
  if (deck.deck!.proposal.schemaVersion !== 2) throw Error("Expected Story deck");
  deck.deck!.proposal.pages[0]!.emphasis = ["The reviewer owns the final decision."];
  render(<WorkspaceView state={deck} busy={false} text="" answer="" correction="" onTextChange={vi.fn()} onAnswerChange={vi.fn()} onCorrectionChange={vi.fn()} onChooseFile={()=>true} onCancelRun={vi.fn()} onAction={()=>true} initialDestination="deck" />);
  expect(within(screen.getByRole("article")).getByText("The reviewer owns the final decision.")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: "Review complete deck" }));
  expect(screen.getAllByRole("article")).toHaveLength(deck.deck!.proposal.pages.length);
  expect(within(screen.getAllByRole("article")[0]!).getByText("The reviewer owns the final decision.")).toBeTruthy();
});
