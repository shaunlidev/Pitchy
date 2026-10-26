import { beforeEach, expect, it } from "vitest";
import { topicLabel, type TopicRef } from "@pitchroom/domain";
import { workspaceCommandSchema, workspaceStateSchema } from "./api-contract";
import { resetFixtureState, addFixtureMaterial, runFixtureAgent, acceptFixture, readFixtureState, answerFixtureQuestion, changeFixtureTopicMaterial, removeFixtureMaterial, generateFixturePositioning, applyFixturePositioning, generateFixtureDeck } from "./fixture-store";
const material = { name: "client.md", mediaType: "text/markdown", text: "Synthetic client adds a second launch constraint." } as const;
let topic: TopicRef;
beforeEach(() => {
  resetFixtureState(); addFixtureMaterial({ name: "initial.txt", mediaType: "text/plain", text: "Atelier helps design teams prepare client presentations." });
  const current = runFixtureAgent(); topic = { understandingId: current.currentVersionId!, kind: "theme", index: 0 };
});
const attach = (commandId = crypto.randomUUID()) => changeFixtureTopicMaterial({ action: "attach", topic, material, commandId });
it("stores one global source, multiple links, pending review and unchanged adopted work", () => {
  const answered = answerFixtureQuestion("Consultant answer already saved", readFixtureState().project.revision);
  topic = { ...topic, understandingId: answered.currentVersionId! };
  acceptFixture(readFixtureState().project.revision);
  generateFixturePositioning(readFixtureState().project.revision);
  applyFixturePositioning("original", readFixtureState().project.revision);
  generateFixtureDeck(readFixtureState().project.revision);
  const before = readFixtureState();
  const first = attach("upload");
  const secondTopic: TopicRef = { ...topic, kind: "gap", index: 0 };
  const source = first.sources.find(s => s.name === material.name)!;
  changeFixtureTopicMaterial({ action: "link", topic: secondTopic, sourceId: source.sourceId, commandId: "other-topic" });
  const result = attach("duplicate-upload");
  expect(result.sources).toHaveLength(2);
  expect(result.topicMaterials).toHaveLength(2);
  expect(result.topicMaterials?.every(link => link.status === "needs_review")).toBe(true);
  expect(result.currentVersionId).toBe(before.currentVersionId);
  expect(result.versions).toEqual(before.versions);
  expect(result.positioning).toEqual(before.positioning);
  expect(result.deck).toEqual(before.deck);
  expect(result.project).toEqual(before.project);
  expect(workspaceStateSchema.parse(result).topicMaterials).toHaveLength(2);
});
it("unlinks only the selected relation, retains source, and permits explicit relinking", () => {
  const first = attach(); const sourceId = first.topicMaterials![0]!.sourceId;
  const other = { ...topic, kind: "gap" as const, index: 0 };
  changeFixtureTopicMaterial({ action: "link", topic: other, sourceId, commandId: "other" });
  const unlinked = changeFixtureTopicMaterial({ action: "unlink", topic, sourceId, commandId: "unlink" });
  expect(unlinked.sources).toEqual(first.sources);
  expect(unlinked.topicMaterials).toEqual([expect.objectContaining(other)]);
  expect(attach().topicMaterials).toHaveLength(2);
});
it("removes all links on file deletion, keeps original source history, never restores links on global reimport", () => {
  const state = attach(); const sourceId = state.topicMaterials![0]!.sourceId;
  const removed = removeFixtureMaterial(sourceId);
  expect(removed.topicMaterials).toEqual([]);
  expect(removed.removedSources).toEqual([expect.objectContaining({ sourceId, content: material.text })]);
  expect(removed.versions).toEqual(state.versions);
  expect(removed.sources).toHaveLength(1);
  expect(addFixtureMaterial(material).topicMaterials).toEqual([]);
});
it("replays a command without mutation and rejects command reuse for another request", () => {
  const first = attach("same-command"); expect(attach("same-command")).toEqual(first);
  expect(() => changeFixtureTopicMaterial({ action: "attach", topic, material: { ...material, text: "Different" }, commandId: "same-command" })).toThrow("Command already used");
  expect(readFixtureState()).toEqual(first);
});
it("rejects missing, cross-version and out of range topics before importing", () => {
  const before = readFixtureState();
  for (const invalid of [{ ...topic, understandingId: "other-project-version" }, { ...topic, index: 999 }]) expect(() => changeFixtureTopicMaterial({ action: "attach", topic: invalid, material, commandId: crypto.randomUUID() })).toThrow();
  expect(readFixtureState()).toEqual(before);
  runFixtureAgent(); const newer = readFixtureState();
  expect(() => attach()).toThrow("older Understanding"); expect(readFixtureState()).toEqual(newer);
});
it("rejects missing source, invalid UTF text payload and negative indexes without writes", () => {
  const before = readFixtureState();
  expect(() => changeFixtureTopicMaterial({ action: "link", topic, sourceId: "missing", commandId: "missing" })).toThrow();
  expect(() => changeFixtureTopicMaterial({ action: "attach", topic, material: { ...material, text: " " }, commandId: "empty" })).toThrow();
  expect(workspaceCommandSchema.safeParse({ action: "link_topic_material", topic: { ...topic, index: -1 }, sourceId: "source", commandId: "bad" }).success).toBe(false);
  expect(readFixtureState()).toEqual(before);
});
it("resolves the actual stored topic label, never an arbitrary client-supplied label", () => {
  const state = attach(); const version = state.versions.find(version => version.id === topic.understandingId)!;
  expect(state.topicMaterials![0]!.label).toBe(topicLabel(version.proposal, topic));
});
