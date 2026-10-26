// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspaceView } from "./workspace-view";
import { addFixtureMaterial, changeFixtureTopicMaterial, readFixtureState, removeFixtureMaterial, resetFixtureState, runFixtureAgent, type FixtureState } from "./fixture-store";
import { workspaceCommandSchema } from "./api-contract";
beforeEach(() => { localStorage.clear(); resetFixtureState(); addFixtureMaterial({ name: "initial.txt", mediaType: "text/plain", text: "Atelier helps consultants prepare a client presentation." }); runFixtureAgent(); });
afterEach(cleanup);
function App() {
  const [state, setState] = useState<FixtureState>(readFixtureState);
  return createElement(WorkspaceView, { state, rememberPosition: true, busy: false, text: "", answer: "saved answer draft", correction: "", initialDestination: "clarify", onTextChange: () => {}, onAnswerChange: () => {}, onCorrectionChange: () => {}, onChooseFile: () => false, onCancelRun: () => {}, onAction: raw => {
    const body = workspaceCommandSchema.parse({ ...raw, commandId: crypto.randomUUID() });
    if (body.action === "link_topic_material" || body.action === "unlink_topic_material") setState(changeFixtureTopicMaterial({ action: body.action === "link_topic_material" ? "link" : "unlink", topic: body.topic, sourceId: body.sourceId, commandId: body.commandId }));
    if (body.action === "remove_material") setState(removeFixtureMaterial(body.sourceId));
    return true;
  }, onChooseFiles: async (files, topic) => {
    if (!topic) return false;
    setState(changeFixtureTopicMaterial({ action: "attach", topic, commandId: crypto.randomUUID(), material: { name: files[0]!.name, mediaType: "text/plain", text: "Synthetic upload" } })); return true;
  } });
}
it("uploads beside a topic, shows pending status in both places and returns to the original topic after reload", async () => {
  const user = userEvent.setup(); const view = render(createElement(App));
  await user.click(screen.getByRole("button", { name: "Clarify" }));
  await user.upload(screen.getByLabelText("Attach TXT or MD to this topic"), new File(["Synthetic upload"], "topic.txt", { type: "text/plain" }));
  const panel = screen.getByRole("region", { name: "Topic materials" });
  expect(within(panel).getByText(/topic.txt · Needs review/)).toBeTruthy();
  const originalLabel = readFixtureState().topicMaterials![0]!.label;
  await user.click(within(panel).getByText("View in Materials"));
  await user.click(screen.getByRole("button", { name: `Return to ${originalLabel}` }));
  expect(screen.getByRole("heading", { name: originalLabel, level: 2 })).toBeTruthy();
  await waitFor(() => expect(localStorage.getItem(`pitchroom:workspace-position:v1:${readFixtureState().project.id}`)).toContain('"topicReturn"'));
  view.unmount(); render(createElement(App));
  expect(await screen.findByRole("heading", { name: originalLabel, level: 2 })).toBeTruthy();
  expect(screen.getByLabelText("Answer the agent’s question")).toBeTruthy();
});
it.each([true, false])("shows historical topic read-only without index reassignment (current Understanding: %s)", async (hasCurrent) => {
  const before = readFixtureState(); const original = { understandingId: before.currentVersionId!, kind: "theme", index: 0 } as const;
  changeFixtureTopicMaterial({ action: "attach", topic: original, material: { name: "original.txt", mediaType: "text/plain", text: "Saved source" }, commandId: "old" });
  if (hasCurrent) runFixtureAgent();
  else addFixtureMaterial({ name: "new-context.txt", mediaType: "text/plain", text: "Another context awaiting an explicit run." });
  localStorage.setItem(`pitchroom:workspace-position:v1:${before.project.id}`, JSON.stringify({ schemaVersion: 1, destination: "clarify", overviewSelection: "theme:0", topicReturn: original }));
  render(createElement(App));
  expect(await screen.findByText(/Original topic from Understanding v1/)).toBeTruthy();
  expect(screen.getByLabelText("Attach TXT or MD to this topic").hasAttribute("disabled")).toBe(true);
  await userEvent.click(screen.getByText("Return to current Understanding"));
  await waitFor(() => expect(screen.queryByText(/Original topic from Understanding v1/)).toBeNull());
});

it("keeps final-source history inspectable after deletion and reopening with zero active sources", async () => {
  const user = userEvent.setup(); const view = render(createElement(App));
  await user.click(screen.getByRole("button", { name: "Materials" }));
  await user.click(screen.getByRole("button", { name: "Remove initial.txt" }));
  await user.click(screen.getByRole("button", { name: "Remove file" }));
  expect(readFixtureState().sources).toHaveLength(0);
  expect(readFixtureState().removedSources).toHaveLength(1);
  await user.click(screen.getByText("Removed sources · historical references"));
  await user.click(screen.getByText("initial.txt · Removed"));
  expect(screen.getByText("Atelier helps consultants prepare a client presentation.")).toBeTruthy();
  view.unmount(); render(createElement(App));
  await user.click(await screen.findByText("Removed sources · historical references"));
  await user.click(screen.getByText("initial.txt · Removed"));
  expect(screen.getByText("Atelier helps consultants prepare a client presentation.")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Add files/ })).toBeTruthy();
  expect(readFixtureState().sources).toHaveLength(0);
});
