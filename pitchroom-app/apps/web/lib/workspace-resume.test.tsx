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

it("recovers from corrupt browser position without losing server work", async () => {
  localStorage.setItem(workspacePositionKey(readFixtureState().project.id), "{broken");
  const before = structuredClone(readFixtureState()); show();
  await screen.findByRole("heading", { name: "Your project materials." });
  expect(readFixtureState()).toEqual(before);
});
