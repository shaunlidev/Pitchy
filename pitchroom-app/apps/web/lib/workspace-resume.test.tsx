// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acceptFixture, addFixtureMaterial, applyFixturePositioning, generateFixtureDeck, generateFixturePositioning, readFixtureState, resetFixtureState, runFixtureAgent } from "./fixture-store";
import { WorkspaceView } from "./workspace-view";
import { workspacePositionKey } from "./workspace-position";
import { useWorkspacePosition } from "./use-workspace-position";

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
  await screen.findByText(/saved working position could not be read/i);
  await screen.findByRole("heading", { name: "Your project materials." });
  expect(readFixtureState()).toEqual(before);
});

it("returns from a single-task gap to that same task in its multi-task theme", async () => {
  const state = readFixtureState();
  const current = state.versions.find(version => version.id === state.currentVersionId)!;
  const gap = current.proposal.gaps[0]!;
  current.proposal.gaps = [{ ...gap, description: "Baseline unknown" }, { ...gap, description: "Timing unknown" }];
  current.proposal.topicTasks = ["baseline", "timing"].map((id, index) => ({ id, themeIndex: 0, relatedGapIndexes: [index], question: { question: `Which ${id}?`, whyItMatters: `The ${id} remains unknown.`, relatedThemeIndexes: [0] } }));
  localStorage.setItem(workspacePositionKey(state.project.id), JSON.stringify({ schemaVersion: 1, destination: "clarify", understandingId: current.id, overviewSelection: "gap:1" }));
  const onAction = vi.fn(() => true);
  render(<WorkspaceView rememberPosition state={state} busy={false} text="" answer="" correction="" onTextChange={() => {}} onAnswerChange={() => {}} onCorrectionChange={() => {}} onChooseFile={() => true} onCancelRun={() => {}} onAction={onAction} />);
  await screen.findByRole("heading", { name: "Which timing?" });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Answer the agent’s question" }), "Timing gap draft");
  await user.click(screen.getByRole("button", { name: "Back to the current useful question" }));
  expect(screen.getByRole("heading", { name: "Which timing?" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Answer the agent’s question" })).toHaveProperty("value", "Timing gap draft");
  expect(onAction).not.toHaveBeenCalled();
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

it("clears the destination, Deck and page notices when a new Deck becomes available in the same view", async () => {
  const state = readFixtureState(), empty = structuredClone(state);
  delete empty.deck; empty.deckVersions = []; empty.sources = []; empty.project.phase = "empty";
  const key = workspacePositionKey(state.project.id);
  localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, destination: "deck", deckId: "gone", pageId: "gone",
    understandingId: "gone", overviewSelection: "theme:99", taskSelections: [{ understandingId: "gone", kind: "theme", index: 0, taskId: "gone" }] }));
  const onAction = vi.fn(() => true);
  const view = (current: typeof state) => <WorkspaceView rememberPosition state={current} busy={false} text="" answer="" correction="" onTextChange={() => {}} onAnswerChange={() => {}} onCorrectionChange={() => {}} onChooseFile={() => true} onCancelRun={() => {}} onAction={onAction} />;
  const mounted = render(view(empty));
  await screen.findByText(/saved deck destination is unavailable/);
  expect(screen.getByText(/no page is selected/)).toBeTruthy();
  mounted.rerender(view(state));
  await waitFor(() => expect(screen.queryByText(/saved Deck is unavailable/)).toBeNull());
  expect(screen.queryByText(/saved deck destination is unavailable|saved page is unavailable/)).toBeNull();
  expect(screen.getByText(/saved topic is unavailable/)).toBeTruthy();
  expect(screen.getByText(/unavailable saved question/)).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ destination: "materials", deckId: state.deck!.id, pageId: state.deck!.proposal.pages[0]!.id });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Deck" }));
  await user.click(within(screen.getByRole("navigation", { name: "Deck pages" })).getAllByRole("button")[1]!);
  mounted.unmount(); render(view(state));
  await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Deck pages" })).getAllByRole("button")[1]!.getAttribute("aria-current")).toBe("page"));
  expect(screen.queryByText(/saved Deck is unavailable|saved page is unavailable/)).toBeNull();
  expect(onAction).not.toHaveBeenCalled();
});

it("acknowledges only a valid selection for the affected Deck, page, topic or question", () => {
  const state = structuredClone(readFixtureState());
  const version = state.versions.find(v => v.id === state.currentVersionId)!;
  const ref = { understandingId: version.id, kind: "theme" as const, index: 0 };
  version.proposal.topicTasks = [0, 1].map(index => ({ id: "task-" + index, themeIndex: index,
    question: { question: "Which detail?", whyItMatters: "The detail is open.", relatedThemeIndexes: [index] } }));
  localStorage.setItem(workspacePositionKey(state.project.id), JSON.stringify({ schemaVersion: 1, destination: "deck", deckId: "gone", pageId: "gone",
    understandingId: version.id, overviewSelection: "theme:99", taskSelections: [{ ...ref, taskId: "gone" }] }));
  const before = structuredClone(state), { result } = renderHook(() => useWorkspacePosition(state, true));
  const choose = (patch: Parameters<typeof result.current.updatePosition>[0]) => act(() => result.current.updatePosition(patch));
  choose({ destination: "materials" }); choose({ pageId: "also-gone", overviewSelection: "gap:999" });
  expect(result.current.storageNotice).toContain("saved page is unavailable");
  choose({ pageId: state.deck!.proposal.pages[0]!.id });
  expect(result.current.storageNotice).not.toContain("saved page is unavailable");
  expect(result.current.storageNotice).toContain("saved Deck is unavailable");
  choose({ deckId: state.deck!.id });
  expect(result.current.storageNotice).not.toContain("saved Deck is unavailable");
  expect(result.current.storageNotice).toContain("saved topic is unavailable");
  choose({ understandingId: version.id, overviewSelection: "theme:0" });
  expect(result.current.storageNotice).not.toContain("saved topic is unavailable");
  choose({ taskSelections: [{ ...ref, index: 1, taskId: "task-1" }] });
  expect(result.current.storageNotice).toContain("unavailable saved question");
  choose({ taskSelections: [{ ...ref, taskId: "task-0" }] });
  expect(result.current.storageNotice).toBeUndefined();
  expect(state).toEqual(before);
});

it("overlays a real write failure on unresolved reasons and clears it only after a successful write", () => {
  const state = readFixtureState(), key = workspacePositionKey(state.project.id);
  localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, destination: "deck", deckId: "missing", pageId: "missing", understandingId: state.currentVersionId, overviewSelection: "theme:0" }));
  const original = localStorage.setItem.bind(localStorage);
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation((k, value) => { if (k === key) throw new Error("Storage full"); original(k, value); });
  try {
    const { result } = renderHook(() => useWorkspacePosition(state, true));
    expect(result.current.storageNotice).toContain("could not be saved");
    act(() => result.current.updatePosition({ pageId: state.deck!.proposal.pages[1]!.id }));
    expect(result.current.storageNotice).toContain("could not be saved");
    expect(result.current.storageNotice).toContain("saved Deck is unavailable");
    expect(result.current.storageNotice).not.toContain("saved page is unavailable");
    spy.mockRestore();
    act(() => result.current.updatePosition({ destination: "materials" }));
    expect(result.current.storageNotice).not.toContain("could not be saved");
    expect(result.current.storageNotice).toContain("saved Deck is unavailable");
    expect(JSON.parse(localStorage.getItem(key)!).pageId).toBe(state.deck!.proposal.pages[1]!.id);
  } finally { spy.mockRestore(); }
});

it("keeps a read failure scoped to its project and preserves the unread record through navigation", () => {
  const state = readFixtureState(), key = workspacePositionKey(state.project.id), other = structuredClone(state);
  other.project.id = "other-project";
  const raw = JSON.stringify({ schemaVersion: 1, destination: "deck", overviewSelection: "theme:0", deckId: state.deck!.id, pageId: state.deck!.proposal.pages[1]!.id, understandingId: state.currentVersionId });
  localStorage.setItem(key, raw);
  const read = localStorage.getItem.bind(localStorage);
  const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(k => { if (k === key) throw new Error("Storage denied"); return read(k); });
  try {
    const { result, rerender } = renderHook(({ current }) => useWorkspacePosition(current, true), { initialProps: { current: state } });
    act(() => result.current.updatePosition({ destination: "clarify" }));
    expect(result.current.storageNotice).toContain("could not be restored");
    expect(read(key)).toBe(raw);
    rerender({ current: other });
    expect(result.current.storageNotice).toBeUndefined();
    expect(result.current.position.destination).toBe("materials");
    spy.mockRestore(); rerender({ current: state });
    expect(result.current.storageNotice).toBeUndefined();
    expect(result.current.position).toMatchObject({ destination: "deck", pageId: state.deck!.proposal.pages[1]!.id });
  } finally { spy.mockRestore(); }
});

it("retries a temporarily unreadable position on navigation without overwriting its unread selections", () => {
  const state = readFixtureState(), key = workspacePositionKey(state.project.id);
  const saved = { schemaVersion: 1, destination: "deck", overviewSelection: "theme:0", understandingId: state.currentVersionId, deckId: state.deck!.id, pageId: state.deck!.proposal.pages[1]!.id };
  localStorage.setItem(key, JSON.stringify(saved));
  const get = localStorage.getItem.bind(localStorage);
  const denied = vi.spyOn(Storage.prototype, "getItem").mockImplementation(k => { if (k === key) throw Error("Temporarily unavailable"); return get(k); });
  try {
    const { result } = renderHook(() => useWorkspacePosition(state, true));
    act(() => result.current.updatePosition({ destination: "clarify" }));
    expect(result.current.storageNotice).toContain("could not be restored");
    expect(JSON.parse(get(key)!)).toEqual(saved);
    denied.mockRestore();
    act(() => result.current.updatePosition({ overviewSelection: "theme:0" }));
    expect(result.current.storageNotice).toBeUndefined();
    expect(JSON.parse(get(key)!)).toMatchObject({ destination: "clarify", deckId: saved.deckId, pageId: saved.pageId });
  } finally { denied.mockRestore(); }
});

it("drops a historical topic return when its version exists but its actual gap does not", () => {
  const state = readFixtureState(), key = workspacePositionKey(state.project.id);
  localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, destination: "clarify", understandingId: state.currentVersionId,
    overviewSelection: "theme:0", topicReturn: { understandingId: state.currentVersionId, kind: "gap", index: 999 } }));
  const { result } = renderHook(() => useWorkspacePosition(state, true));
  expect(result.current.position.topicReturn).toBeUndefined();
  expect(result.current.storageNotice).toContain("saved topic is unavailable");
  act(() => result.current.updatePosition({ destination: "materials" }));
  expect(result.current.storageNotice).toContain("saved topic is unavailable");
  act(() => result.current.updatePosition({ understandingId: state.currentVersionId, overviewSelection: "theme:0" }));
  expect(result.current.storageNotice).toBeUndefined();
});
