// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acceptFixture, addFixtureMaterial, applyFixturePositioning, generateFixtureDeck, generateFixturePositioning, readFixtureState, resetFixtureState, runFixtureAgent } from "./fixture-store";
import { WorkspaceView } from "./workspace-view";
import { workspacePositionKey } from "./workspace-position";

beforeEach(() => {
  localStorage.clear(); resetFixtureState();
  addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier prepares client presentations." });
  const reviewed = runFixtureAgent(); acceptFixture(reviewed.project.revision);
  generateFixturePositioning(); applyFixturePositioning("evidence-first", readFixtureState().project.revision); generateFixtureDeck(readFixtureState().project.revision);
});
afterEach(cleanup);
const show = (onAction = vi.fn(() => true)) => render(<WorkspaceView rememberPosition state={readFixtureState()} busy={false} text="" answer="" correction="" onTextChange={() => {}} onAnswerChange={() => {}} onCorrectionChange={() => {}} onChooseFile={() => true} onCancelRun={() => {}} onAction={onAction} />);

it("resumes the selected Deck page across navigation and remount without a business action", async () => {
  const user = userEvent.setup(); const onAction = vi.fn(() => true);
  const first = show(onAction);
  await user.click(screen.getByRole("button", { name: "Deck" }));
  const pages = within(screen.getByRole("navigation", { name: "Deck pages" })).getAllByRole("button");
  await user.click(pages[1]!);
  const label = pages[1]!.textContent;
  await user.click(screen.getByRole("button", { name: "Materials" }));
  await user.click(screen.getByRole("button", { name: "Deck" }));
  expect(within(screen.getByRole("navigation", { name: "Deck pages" })).getAllByRole("button")[1]!.getAttribute("aria-current")).toBe("page");
  first.unmount(); show(onAction);
  await waitFor(() => expect(screen.getByRole("navigation", { name: "Deck pages" })).toBeTruthy());
  const restored = within(screen.getByRole("navigation", { name: "Deck pages" })).getAllByRole("button")[1]!;
  expect(restored.textContent).toBe(label); expect(restored.getAttribute("aria-current")).toBe("page");
  expect(onAction).not.toHaveBeenCalled();
});

it("keeps the inspected Clarify topic on return and after reload", async () => {
  const user = userEvent.setup(); const first = show();
  await user.click(screen.getByRole("button", { name: "Clarify" }));
  const topic = within(screen.getByLabelText("Project topics")).getAllByRole("button").find(button => button.textContent?.includes("Open question 1"))!;
  await user.click(topic);
  await user.click(screen.getByRole("button", { name: "Materials" }));
  await user.click(screen.getByRole("button", { name: "Clarify" }));
  expect(screen.getByText("Open question 1", { selector: ".overviewFocus .eyebrow" })).toBeTruthy();
  first.unmount(); show();
  await waitFor(() => expect(screen.getByText("Open question 1", { selector: ".overviewFocus .eyebrow" })).toBeTruthy());
});

it("resumes a second question within one topic with its own draft and no business action", async () => {
  const state = readFixtureState();
  const current = state.versions.find(version => version.id === state.currentVersionId)!;
  current.proposal.topicTasks = ["baseline", "timing"].map(id => ({ id, themeIndex: 0, relatedGapIndexes: [0], question: { question: `Which ${id}?`, whyItMatters: `The ${id} remains unknown.`, relatedThemeIndexes: [0] } }));
  const otherThemeIndex = current.proposal.themes.length;
  current.proposal.themes.push({ title: "Another audience topic", summary: "The audience remains unknown.", claims: structuredClone(current.proposal.themes[0]!.claims) });
  current.proposal.topicTasks.push({ id: "audience", themeIndex: otherThemeIndex, question: { question: "Which audience?", whyItMatters: "The audience remains unknown.", relatedThemeIndexes: [otherThemeIndex] } });
  const before = structuredClone(state);
  const onAction = vi.fn(() => true);
  const mount = () => render(<WorkspaceView rememberPosition state={state} busy={false} text="" answer="" correction="" onTextChange={() => {}} onAnswerChange={() => {}} onCorrectionChange={() => {}} onChooseFile={() => true} onCancelRun={() => {}} onAction={onAction} />);
  const user = userEvent.setup(); const first = mount();
  await user.click(screen.getByRole("button", { name: "Clarify" }));
  await user.type(screen.getByRole("textbox", { name: "Answer the agent’s question" }), "Baseline draft");
  await user.click(screen.getByText("Project overview"));
  await user.click(within(screen.getByLabelText("Project topics")).getAllByRole("button").find(button => button.textContent?.includes("Open question 1"))!);
  await user.click(screen.getByText("Other questions for this topic"));
  await user.click(screen.getByRole("button", { name: "Which timing?" }));
  await user.type(screen.getByRole("textbox", { name: "Answer the agent’s question" }), "Timing draft");
  await user.click(screen.getByText("Project overview"));
  await user.click(screen.getByRole("button", { name: /Another audience topic/ }));
  await user.click(screen.getByText("Project overview"));
  const originalTopic = within(screen.getByLabelText("Project topics")).getAllByRole("button").find(button => button.textContent?.startsWith(current.proposal.themes[0]!.title))!;
  await user.click(originalTopic);
  expect(screen.getByRole("heading", { name: "Which timing?" })).toBeTruthy();
  first.unmount(); mount();
  await screen.findByRole("heading", { name: "Which timing?" });
  expect(screen.getByRole("textbox", { name: "Answer the agent’s question" })).toHaveProperty("value", "Timing draft");
  await user.click(screen.getByRole("button", { name: "Materials" }));
  await user.click(screen.getByRole("button", { name: "Clarify" }));
  expect(screen.getByRole("heading", { name: "Which timing?" })).toBeTruthy();
  await user.click(screen.getByText("Other questions for this topic"));
  await user.click(screen.getByRole("button", { name: "Which baseline?" }));
  expect(screen.getByRole("textbox", { name: "Answer the agent’s question" })).toHaveProperty("value", "Baseline draft");
  expect(onAction).not.toHaveBeenCalled(); expect(state).toEqual(before);
});

it("recovers from corrupt browser position without losing server work", async () => {
  localStorage.setItem(workspacePositionKey(readFixtureState().project.id), "{broken");
  const before = structuredClone(readFixtureState()); show();
  await screen.findByRole("heading", { name: "Your project materials." });
  expect(readFixtureState()).toEqual(before);
});

it("does not invite an answer to another topic's question", async () => {
  const state = readFixtureState();
  const version = state.versions.find(candidate => candidate.id === state.currentVersionId)!;
  version.proposal.themes.push({ title: "Unrelated topic", summary: "No question is associated with this topic.", claims: structuredClone(version.proposal.themes[0]!.claims) });
  const user = userEvent.setup(); const onAction = vi.fn(() => true);
  render(<WorkspaceView initialDestination="clarify" state={state} busy={false} text="" answer="Preserve this unsent answer" correction="" onTextChange={() => {}} onAnswerChange={() => {}} onCorrectionChange={() => {}} onChooseFile={() => true} onCancelRun={() => {}} onAction={onAction} />);
  await user.click(screen.getByRole("button", { name: /Unrelated topic/ }));
  expect(screen.queryByRole("textbox", { name: "Answer the agent’s question" })).toBeNull();
  expect(screen.getByText("No question is linked to this topic yet.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Back to the current useful question" }));
  expect((screen.getByRole("textbox", { name: "Answer the agent’s question" }) as HTMLTextAreaElement).value).toBe("Preserve this unsent answer");
  expect(onAction).not.toHaveBeenCalled();
});


it.each([
  ["Deck", { deckId: "removed-deck", pageId: "removed-page" }, "The saved Deck is unavailable; selected the current Deck."],
  ["page", { pageId: "removed-page" }, "The saved page is unavailable; selected the first page."],
  ["topic", { understandingId: "superseded" }, "The saved topic is unavailable in the current understanding; selected the current default topic."],
  ["topic index", { overviewSelection: "gap:999" }, "The saved topic is unavailable in the current understanding; selected the current default topic."],
  ["question", { taskSelections: [{ understandingId: "removed", kind: "theme", index: 0, taskId: "removed-task" }] }, "An unavailable saved question was not restored. Your saved project work is unchanged."],
])("explains unavailable saved %s without business actions or forced navigation", async (_label, patch, message) => {
  const state = readFixtureState();
  const before = structuredClone(state);
  const deck = state.deck!;
  localStorage.setItem(workspacePositionKey(state.project.id), JSON.stringify({ schemaVersion: 1, destination: "deck", understandingId: state.currentVersionId, overviewSelection: "theme:0", deckId: deck.id, pageId: deck.proposal.pages[1]!.id, ...patch }));
  const onAction = vi.fn(() => true);
  show(onAction);
  await screen.findByText(text => text.includes(message), { selector: '[role="status"]' });
  expect(screen.getByRole("navigation", { name: "Deck pages" })).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: "Materials" }));
  expect(screen.getByRole("heading", { name: "Your project materials." })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(workspacePositionKey(state.project.id))!).destination).toBe("materials");
  expect(onAction).not.toHaveBeenCalled();
  expect(readFixtureState()).toEqual(before);
});

it("explains an inaccessible saved destination and stays at the safe fallback", async () => {
  const state = structuredClone(readFixtureState());
  delete state.deck; state.deckVersions = []; state.sources = []; state.project.phase = "empty";
  const before = structuredClone(state);
  localStorage.setItem(workspacePositionKey(state.project.id), JSON.stringify({ schemaVersion: 1, destination: "deck", overviewSelection: "theme:0", deckId: "removed", pageId: "removed" }));
  const onAction = vi.fn(() => true);
  render(<WorkspaceView rememberPosition state={state} busy={false} text="" answer="" correction="" onTextChange={() => {}} onAnswerChange={() => {}} onCorrectionChange={() => {}} onChooseFile={() => true} onCancelRun={() => {}} onAction={onAction} />);
  await screen.findByText(text => text.includes("The saved deck destination is unavailable; opened materials."), { selector: '[role="status"]' });
  expect(screen.getByRole("button", { name: "Materials" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("navigation", { name: "Deck pages" })).toBeNull();
  expect(onAction).not.toHaveBeenCalled(); expect(state).toEqual(before);
});

it("does not warn about recovery on first open or intentional navigation", async () => {
  show();
  await userEvent.setup().click(screen.getByRole("button", { name: "Deck" }));
  expect(screen.queryByText(/The saved .*unavailable/)).toBeNull();
});
