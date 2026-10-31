import { expect, it } from "vitest";
import { semanticVerdict, assessTask, scoreReview, type SemanticFacts } from "./verdict";
import { fixture, httpFixture } from "./review-fixture";
import { appendWorkflowReview, advance, prepare, readWorkflowReviewContext } from "./workflow";
import { taskRubric } from "./schema";
import { runTaskAcceptanceCLI } from "./cli";
const empty = (): SemanticFacts => ({ confirmedFailures: [], disputes: [], missingOutputs: [], missingReviews: [], lowScores: [], noncriticalFindings: [], reviewHashes: [] });
it("uses explicit semantic precedence without averaging away failures or hiding disputes", () => {
  const facts = empty();
  expect(semanticVerdict(facts).kind).toBe("pass");
  facts.lowScores.push("score"); expect(semanticVerdict(facts).kind).toBe("fail");
  facts.missingReviews.push("review"); expect(semanticVerdict(facts).kind).toBe("awaiting_review");
  facts.missingOutputs.push("output"); expect(semanticVerdict(facts).kind).toBe("incomplete");
  facts.disputes.push("critical-dispute"); expect(semanticVerdict(facts).kind).toBe("disputed");
  facts.confirmedFailures.push("separate-confirmed-failure"); expect(semanticVerdict(facts)).toEqual({ kind: "fail", findingIds: ["separate-confirmed-failure"] });
});
it("keeps prepared-run engineering, semantics and actual use separate without an overall pass", async () => {
  const f = fixture(), run = prepare(f.input), result = assessTask(run);
  expect(result).toMatchObject({ kind: "task_assessment", engineering: { kind: "incomplete" }, semantic: { kind: "incomplete" }, userTask: { kind: "awaiting_observation" } });
  expect(result).not.toHaveProperty("overall");
  let output = "";
  expect(await runTaskAcceptanceCLI(["assess", "--run", run.referenceFile], text => { output += text; })).toBe(0);
  expect(JSON.parse(output).result).toMatchObject({ kind: "task_assessment", userTask: { kind: "awaiting_observation" } });
});
it("refuses forged bridge records on reread and actual assess CLI returns a tool error", async () => {
  const f = await httpFixture(), run = prepare(f.input), progress = await advance(run);
  if (progress.kind !== "awaiting_human") throw new Error("No checkpoint");
  appendWorkflowReview(run, () => ({ id: "review:forged", at: "2026-10-30T00:00:00Z", checkpointHash: progress.checkpointHash, data: { kind: "review_packet", id: "forged", desiredResult: "pass" } }));
  expect(readWorkflowReviewContext(run).records).toHaveLength(1);
  expect(assessTask(run)).toMatchObject({ kind: "assessment_unavailable", integrity: { kind: "unverified" } });
  let output = "";
  expect(await runTaskAcceptanceCLI(["assess", "--run", run.referenceFile], text => { output += text; })).toBe(1);
  expect(JSON.parse(output).result).toMatchObject({ kind: "assessment_unavailable" });
}, 20000);

it("enforces every frozen rubric dimension and positioning minimum/mean independently", () => {
 const positioning = (values: number[]) => taskRubric.positioning.dimensions.map((dimension, index) => ({ dimension, score: values[index] ?? 0, reason: "Synthetic score." }));
 expect(scoreReview("positioning", positioning([2, 2, 2, 2, 2]), "Different tradeoffs")).toBe("below_threshold");
 expect(scoreReview("positioning", positioning([1, 4, 4, 4, 4]), "Different tradeoffs")).toBe("below_threshold");
 expect(scoreReview("positioning", positioning([2, 3, 3, 3, 4]), "Different tradeoffs")).toBe("pass");
 expect(scoreReview("positioning", positioning([4, 4, 4, 4, 4]), "")).toBe("missing");
 const story = taskRubric.storyDeck.dimensions.map(dimension => ({ dimension, score: 3, reason: "Synthetic score." }));
 expect(scoreReview("deck", story, "")).toBe("pass");
 expect(scoreReview("deck", story.slice(1), "")).toBe("missing");
 expect(scoreReview("deck", story.map((item, index) => ({ ...item, score: index === 0 ? 2 : 4 })), "")).toBe("below_threshold");
 expect(scoreReview("deck", story.map(item => ({ ...item, dimension: "faithfulness" })), "")).toBe("missing");
});
