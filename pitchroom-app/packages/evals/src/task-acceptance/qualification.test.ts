import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { httpFixture } from "./review-fixture";
import { advance, audit, prepare, readWorkflowReviewContext } from "./workflow";
import { recordReviewEvidence, reviewRecords, type ReviewPacket } from "./review";
import { assessTask } from "./verdict";
import { hashTaskValue, parseTaskBundle } from "./schema";
import { qualificationGoalUpgrade, qualificationPacket, qualificationReviewer, qualificationView, writeQualificationCase } from "../../../../scripts/qa-task-acceptance";

async function controlledReview() {
  const fixture = await httpFixture();
  const caseDirectory = join(fixture.root, "pit56-case"), bundle = writeQualificationCase(caseDirectory);
  fixture.input.caseDirectory = caseDirectory;
  // Ordinary CI unit-fixture lifecycle. These tests do not establish retained
  // formal qualification; the standalone entry independently retains every control.
  const run = prepare(fixture.input), reviewer = qualificationReviewer(run);
  const view = qualificationView.parse(await advance(run));
  const packet = qualificationPacket(run, view.checkpointHash, reviewer);
  return { fixture, bundle, run, reviewer, view, packet };
}

it("keeps absent or partial review pending and refuses every stale review binding", async () => {
  const { run, packet, view } = await controlledReview();
  const assessment = assessTask(run);
  expect(assessment.kind).toBe("task_assessment");
  if (!assessment.attemptHistory) throw new Error("Missing actual committed output assessment");
  expect(assessment.attemptHistory.find(item => item.binding.checkpointHash === view.checkpointHash)?.semantic.kind).toBe("awaiting_review");
  expect(() => recordReviewEvidence(run, { ...packet, fields: packet.fields.slice(1) })).toThrow(/REVIEW_FIELD_COVERAGE|REVIEW_EMPTY_FIELDS_REASON_REQUIRED/);
  expect(() => recordReviewEvidence(run, { ...packet, oracle: packet.oracle.slice(1) })).toThrow("REVIEW_ORACLE_COVERAGE");
  expect(reviewRecords(readWorkflowReviewContext(run)).filter(item => item.kind === "review_packet")).toEqual([]);
  for (const key of ["outputHash", "codeFingerprintHash", "promptFingerprintHash", "modelConfigHash"] as const) {
    expect(() => recordReviewEvidence(run, { ...packet, binding: { ...packet.binding, [key]: hashTaskValue("changed") } })).toThrow("REVIEW_BINDING_MISMATCH");
  }
  expect(() => recordReviewEvidence(run, { ...packet, binding: { ...packet.binding, caseBinding: { ...packet.binding.caseBinding, oracleHash: hashTaskValue("changed") } } })).toThrow("REVIEW_BINDING_MISMATCH");
  recordReviewEvidence(run, packet);
  const after = assessTask(run);
  if (!after.attemptHistory) throw new Error("Missing reviewed output assessment");
  expect(after.attemptHistory.find(item => item.binding.checkpointHash === view.checkpointHash)?.semantic.kind).toBe("pass");
  expect(after.semantic.kind).toBe("incomplete");
  expect(after.userTask.kind).toBe("awaiting_observation");
}, 30_000);

it("a confirmed critical omission fails independently of otherwise passing scores", async () => {
  const { run, packet } = await controlledReview();
  const omission: ReviewPacket = { ...packet, oracle: packet.oracle.map(item => item.oracleId === "unknown"
    ? { ...item, verdict: "violated", reason: "Known negative control: material owner confirms that a critical approval limit was omitted." }
    : item) };
  recordReviewEvidence(run, omission);
  expect(assessTask(run).semantic.kind).toBe("fail");
  expect(reviewRecords(readWorkflowReviewContext(run)).find(item => item.kind === "review_packet")).toEqual(omission);
  const hash = hashTaskValue(omission), count = readWorkflowReviewContext(run).records.length;
  expect(recordReviewEvidence(run, omission).recordHash).toBe(hash);
  expect(readWorkflowReviewContext(run).records).toHaveLength(count);
}, 30_000);

it("a reviewer-confirmed goal-to-achievement upgrade fails even with a genuine citation", async () => {
  const { run, packet } = await controlledReview();
  const source = readWorkflowReviewContext(run).bundle.fixture.sources[0];
  if (!source) throw new Error("Missing actual synthetic material");
  const goalUpgrade = qualificationGoalUpgrade(run, packet);
  recordReviewEvidence(run, goalUpgrade);
  expect(assessTask(run).semantic.kind).toBe("fail");
  expect(goalUpgrade.fields.some(item => item.kind === "claims" && item.claims[0]?.evidenceRefs[0]?.quote === source.material)).toBe(true);
}, 30_000);

it("changed frozen oracle and synthetic provenance cannot inherit real R1 approval", async () => {
  const { run, bundle, packet } = await controlledReview();
  expect(() => parseTaskBundle({ ...bundle, oracle: { ...bundle.oracle, items: bundle.oracle.items.map(item => ({ ...item, rationale: "changed oracle" })) } })).toThrow("FROZEN_BINDING_MISMATCH");
  expect(() => parseTaskBundle({ ...bundle, taskCase: { ...bundle.taskCase, spec: { ...bundle.taskCase.spec, caseKind: "real_self_test", participantMode: "assisted_self_test" } } })).toThrow("FROZEN_BINDING_MISMATCH");
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed during local assessment"));
  recordReviewEvidence(run, packet);
  expect(audit(run).purpose).toBe("tool_validation");
  expect(readWorkflowReviewContext(run).bundle.taskCase.spec.participantMode).toBe("scripted_synthetic");
  expect(assessTask(run).userTask.kind).toBe("awaiting_observation");
  expect(network).not.toHaveBeenCalled();
}, 30_000);
