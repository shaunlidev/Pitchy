import { describe, expect, it } from "vitest";
import { understandingProposalV1Schema, topicTasksFor, type UnderstandingProposalV1 } from "./understanding";
import { newClarification, buildClarificationCandidate } from "./clarification";

const question = (text: string, themeIndex: number) => ({ question: text, whyItMatters: "An unresolved choice in the material.", relatedThemeIndexes: [themeIndex] });
function proposal(): UnderstandingProposalV1 {
  return understandingProposalV1Schema.parse({ schemaVersion: 1,
    themes: ["Audience", "Measurement", "Timing"].map(title => ({ title, summary: `${title} remains unknown.`, claims: [{ statement: `${title} is unknown.`, evidenceState: "unknown", evidence: [] }] })),
    gaps: [{ description: "Measurement baseline missing", whyItMatters: "Cannot assess the reported target.", relatedSourceIds: [] }],
    nextQuestion: question("Who is the audience?", 0),
    topicTasks: [{ id: "audience", themeIndex: 0, question: question("Who is the audience?", 0) }, { id: "measurement", themeIndex: 1, relatedGapIndexes: [0], question: question("How will the target be measured?", 1) }],
  });
}
function task(base = proposal(), themeIndex = 1, taskId = "measurement") {
  return newClarification({ id: "saved-answer", inputId: "input", projectId: "synthetic", commandId: "command", actorId: "tester", versionId: "v1", revision: 1, base, sources: [], answer: "The baseline is unknown.", selection: { understandingId: "v1", taskId, themeIndex } });
}
describe("Topic task ownership", () => {
  it("shows only directly associated tasks, including explicitly associated gaps", () => {
    const base = proposal();
    expect(topicTasksFor(base, "theme", 1).map(t => t.id)).toEqual(["measurement"]);
    expect(topicTasksFor(base, "gap", 0).map(t => t.id)).toEqual(["measurement"]);
    expect(topicTasksFor(base, "theme", 2)).toEqual([]);
  });
  it("does not fill a quota or fall back to legacy for an explicitly empty collection", () => {
    const base = proposal(); base.topicTasks = [];
    expect(topicTasksFor(base, "theme", 0)).toEqual([]);
    expect(understandingProposalV1Schema.parse(base).topicTasks).toEqual([]);
  });
  it("keeps legacy questions only under their original related topics", () => {
    const base = proposal(); delete base.topicTasks;
    expect(topicTasksFor(base, "theme", 0)[0]?.question).toEqual(base.nextQuestion);
    expect(topicTasksFor(base, "theme", 1)).toEqual([]);
    expect(topicTasksFor(base, "gap", 0)).toEqual([]);
  });
  it("rejects invalid task associations and suppresses invalid stale display entries", () => {
    const base = proposal(); base.topicTasks![1]!.question.relatedThemeIndexes = [0];
    expect(understandingProposalV1Schema.safeParse(base).success).toBe(false);
    expect(topicTasksFor(base, "theme", 1)).toEqual([]);
    expect(() => task(base)).toThrow();
  });
  it("rejects missing selection, wrong topic, and old version selections", () => {
    expect(() => task(proposal(), 0)).toThrow();
    expect(() => newClarification({ ...task(), id: "new", versionId: "v2", revision: 2 })).toThrow();
    expect(() => newClarification({ id: "new", inputId: "i", projectId: "p", commandId: "c", actorId: "u", versionId: "v1", revision: 1, base: proposal(), sources: [], answer: "answer" })).toThrow();
  });
  it("snapshots the selected question and requires explicit candidate application", () => {
    const saved = task();
    expect(saved.question.question).toBe("How will the target be measured?");
    const original = structuredClone(saved.base);
    const candidate = buildClarificationCandidate(saved, { schemaVersion: 2, reason: "Save an attributed answer.", operations: [{ type: "add_answer", themeId: saved.base.themes[1]!.id }] });
    expect(saved.base).toEqual(original);
    expect(candidate.themes[0]).toEqual(original.themes[0]);
    expect(candidate.themes[1]!.claims.at(-1)?.userInputIds).toEqual(["input"]);
    expect(candidate.themes[1]!.claims[0]!.evidenceState).toBe("unknown");
    expect(candidate.topicTasks?.map(t => t.id)).toEqual(["audience"]);
  });
  it("rejects cross-topic answer and summary attribution at the Apply boundary", () => {
    const saved = task();
    for (const op of [{ type: "add_answer", themeId: saved.base.themes[0]!.id }, { type: "update_summary", themeId: saved.base.themes[0]!.id, text: "A different topic" }]) {
      expect(() => buildClarificationCandidate(saved, { schemaVersion: 2, reason: "Wrong ownership", operations: [op] })).toThrow(/different topic/);
    }
  });
});
