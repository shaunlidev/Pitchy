import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  executionStateSchema, freezeTaskBundle, hashTaskValue, parseTaskBundle, previewTaskModelInput,
  productCheckpointPayloadSchema, requireMatchingReviewBinding, requireTaskGenerationInput,
  semanticVerdictSchema, taskAssessmentSchema, taskCaseSchema, taskRubric,
} from "./schema";

const fixtureRoot = new URL("../../config/task-acceptance/pitchroom-r1/", import.meta.url);
const loadCommitted = () => ({
  taskCase: JSON.parse(readFileSync(new URL("case.json", fixtureRoot), "utf8")),
  oracle: JSON.parse(readFileSync(new URL("oracle.json", fixtureRoot), "utf8")),
  materialPackageText: readFileSync(new URL("materials.json", fixtureRoot), "utf8"),
});
const load = () => {
  const input = loadCommitted();
  return { ...input, taskCase: { schemaVersion: 1, status: "draft", spec: input.taskCase.spec, openDecisions: [{ id: "synthetic-confirmation", question: "Confirm test draft?", recommendation: "Synthetic control only." }] } };
};
const confirmation = { actor: "synthetic test owner", role: "material_owner_and_product_owner", confirmedAt: "2026-10-27T00:00:00Z", evidenceRef: "synthetic test approval; not Shaun's confirmation" };
function freeze() {
  const input = load(), bundle = parseTaskBundle(input);
  return parseTaskBundle({ ...input, taskCase: freezeTaskBundle({ bundle, confirmation, binding: bundle.binding }) });
}
function approval(bundle: ReturnType<typeof freeze>) {
  return { binding: bundle.binding, sourceIds: bundle.fixture.sources.map(source => source.id), provider: "synthetic-provider", model: "synthetic-model", purpose: "task_acceptance_r1", confirmation };
}
const hash = hashTaskValue("synthetic-receipt");

describe("PIT-50 task acceptance contract (offline synthetic controls)", () => {
  it("parses the owner-confirmed R1 without inventing source dates or transfer permission", () => {
    const bundle = parseTaskBundle(loadCommitted());
    expect(bundle.taskCase.status).toBe("frozen");
    if (bundle.taskCase.status !== "frozen") throw new Error("Expected confirmed case");
    expect(bundle.taskCase.confirmation.actor).toBe("Shaun");
    expect(bundle.taskCase.confirmation.evidenceRef).toContain("01a17ad5-5704-782c-b163-5d92677d1665");
    expect(bundle.fixture.sources).toHaveLength(5);
    expect(bundle.oracle.items).toHaveLength(14);
    expect(bundle.taskCase.spec.materials.every(item => item.sourceDate.kind === "unknown" && item.permission.kind === "local_evaluation_only")).toBe(true);
    expect(bundle.taskCase.spec.participantMode).toBe("assisted_self_test");
  });

  it.each(["audience", "decisionGoal", "useContext"])("keeps missing %s in draft and refuses freeze or preview", field => {
    const input = load(); input.taskCase.spec[field] = null;
    const bundle = parseTaskBundle(input);
    expect(bundle.taskCase.status).toBe("draft");
    expect(() => previewTaskModelInput(bundle)).toThrow("TASK_CONTEXT_INCOMPLETE");
    expect(() => freezeTaskBundle({ bundle, confirmation, binding: bundle.binding })).toThrow();
  });

  it("requires material-owner confirmation and the exact binding before freezing", () => {
    const bundle = parseTaskBundle(load());
    expect(() => freezeTaskBundle({ bundle, confirmation: {}, binding: bundle.binding })).toThrow();
    expect(() => freezeTaskBundle({ bundle, confirmation, binding: { ...bundle.binding, oracleHash: hash } })).toThrow("CONFIRMATION_BINDING_MISMATCH");
    expect(freeze().taskCase.status).toBe("frozen");
    expect(bundle.taskCase.status).toBe("draft");
  });

  it("rejects source byte drift even if the parsed values look the same", () => {
    const input = load(); input.materialPackageText += "\n";
    expect(() => parseTaskBundle(input)).toThrow("MATERIAL_PACKAGE_MISMATCH");
  });

  it("rejects altered source receipts, missing coverage and fabricated oracle quotes", () => {
    const input = load(); input.taskCase.spec.materials[0].sourceSha256 = hash;
    expect(() => parseTaskBundle(input)).toThrow("SOURCE_RECEIPT_MISMATCH");
    const missing = load(); missing.taskCase.spec.materials.pop();
    expect(() => parseTaskBundle(missing)).toThrow("MATERIAL_COVERAGE_MISMATCH");
    const quoted = load(); quoted.oracle.items[0].sourceRefs[0].quote = "All consultants have already bought Pitchroom.";
    expect(() => parseTaskBundle(quoted)).toThrow("SOURCE_QUOTE_MISMATCH");
  });

  it("rejects mismatched case/rule versions, duplicate IDs and omitted required stages", () => {
    const input = load(); input.oracle.caseVersion = "another-version";
    expect(() => parseTaskBundle(input)).toThrow("CASE_OR_RULE_VERSION_MISMATCH");
    const duplicate = load(); duplicate.oracle.items.push(duplicate.oracle.items[0]);
    expect(() => parseTaskBundle(duplicate)).toThrow();
    const stage = load(); stage.taskCase.spec.requiredStages = ["materials", "deck"];
    expect(() => parseTaskBundle(stage)).toThrow();
  });

  it("does not mislabel self-validation as an independent participant", () => {
    const input = load(); input.taskCase.spec.participantMode = "observed_external";
    expect(() => parseTaskBundle(input)).toThrow();
  });

  it("revalidates frozen input/oracle so post-approval mutation cannot inherit approval", () => {
    const bundle = freeze(); bundle.oracle.items[0].meaning = "changed verdict rule";
    expect(() => requireTaskGenerationInput({ bundle, transferApproval: approval(bundle), provider: "synthetic-provider", model: "synthetic-model" })).toThrow("FROZEN_BINDING_MISMATCH");
    const input = load(); const prepared = parseTaskBundle(input);
    prepared.taskCase.spec.originalFraming = "edited after parsing";
    expect(() => freezeTaskBundle({ bundle: prepared, confirmation, binding: prepared.binding })).toThrow("ORIGINAL_FRAMING_MISMATCH");
  });

  it("keeps generation closed for a draft, missing permission, wrong provider/model or source scope", () => {
    const draft = parseTaskBundle(load());
    expect(() => requireTaskGenerationInput({ bundle: draft, transferApproval: {}, provider: "x", model: "y" })).toThrow("CASE_NOT_FROZEN");
    const bundle = freeze();
    expect(() => requireTaskGenerationInput({ bundle, transferApproval: {}, provider: "x", model: "y" })).toThrow();
    expect(() => requireTaskGenerationInput({ bundle, transferApproval: approval(bundle), provider: "other-provider", model: "synthetic-model" })).toThrow("TRANSFER_SCOPE_MISMATCH");
    expect(() => requireTaskGenerationInput({ bundle, transferApproval: { ...approval(bundle), sourceIds: ["v6-prd-objective"] }, provider: "synthetic-provider", model: "synthetic-model" })).toThrow("TRANSFER_SOURCE_SCOPE_MISMATCH");
  });

  it("releases only allowlisted user material, not oracle/score/confirmation", () => {
    const bundle = freeze();
    const actual = requireTaskGenerationInput({ bundle, transferApproval: approval(bundle), provider: "synthetic-provider", model: "synthetic-model" });
    expect(Object.keys(actual).sort()).toEqual(["sources", "task"]);
    expect(Object.keys(actual.task).sort()).toEqual(["audience", "decisionGoal", "originalFraming", "outputLanguage", "useContext"]);
    expect(actual.sources).toEqual(bundle.fixture.sources);
    const serialized = JSON.stringify(actual);
    for (const item of bundle.oracle.items) expect(serialized).not.toContain(item.id);
    for (const value of ["oracleVersion", "rubricVersion", "confirmedAt", "openDecisions", "minimumEach", "source_grounded_proposal"]) expect(serialized).not.toContain(value);
    expect(actual.task.originalFraming).toBe(bundle.fixture.originalFraming);
    expect(actual.sources[0].boundary).toContain("does not establish measured");
  });

  it.each(["specHash", "materialPackageHash", "oracleHash", "rubricHash"])("refuses stale frozen %s", field => {
    const bundle = freeze(); const taskCase = structuredClone(bundle.taskCase);
    if (taskCase.status !== "frozen") throw new Error("Expected frozen control");
    const edited = { ...taskCase, binding: { ...taskCase.binding, [field]: hash } };
    expect(() => parseTaskBundle({ ...bundle, taskCase: edited })).toThrow("FROZEN_BINDING_MISMATCH");
  });

  it.each(["checkpointHash", "outputHash", "codeFingerprintHash", "promptFingerprintHash", "modelConfigHash"])("refuses a review reused after %s changes", field => {
    const bundle = freeze();
    const expected = { caseBinding: bundle.binding, checkpointHash: hash, outputHash: hash, codeFingerprintHash: hash, promptFingerprintHash: hash, modelConfigHash: hash };
    expect(requireMatchingReviewBinding({ expected, reviewed: expected })).toEqual(expected);
    expect(() => requireMatchingReviewBinding({ expected, reviewed: { ...expected, [field]: hashTaskValue("changed") } })).toThrow("REVIEW_BINDING_MISMATCH");
  });

  it("keeps independent outcomes, rejects bare PASS and unknown action/permission fields", () => {
    expect(semanticVerdictSchema.safeParse({ kind: "pass" }).success).toBe(false);
    expect(executionStateSchema.safeParse({ kind: "outcome_unknown", stage: "story_initial", commandId: "c", attemptId: "a", reason: "response lost" }).success).toBe(true);
    expect(executionStateSchema.safeParse({ kind: "outcome_unknown", stage: "story_initial", reason: "lost" }).success).toBe(false);
    const input = load();
    expect(taskCaseSchema.safeParse({ ...input.taskCase, autoApply: true }).success).toBe(false);
    const assessment = { execution: { kind: "prepared" }, integrity: { kind: "invalid", reasons: ["output modified"] }, engineering: { kind: "pass", checkReceiptHashes: [hash] }, semantic: { kind: "awaiting_review", missingReviewIds: ["all"] }, userTask: { kind: "awaiting_observation", missingEvidence: ["actual use"] } };
    expect(taskAssessmentSchema.safeParse(assessment).success).toBe(false);
  });

  it("reuses product payload validation rather than accepting an arbitrary Story or V1 Deck", () => {
    expect(productCheckpointPayloadSchema.safeParse({ stage: "story_initial", output: { schemaVersion: 1 } }).success).toBe(false);
    expect(productCheckpointPayloadSchema.safeParse({ stage: "deck", output: { schemaVersion: 1 } }).success).toBe(false);
    expect(productCheckpointPayloadSchema.safeParse({ stage: "materials", output: {} }).success).toBe(false);
  });

  it("keeps v2 Positioning and new Story/Deck thresholds distinct from historical live four scores", () => {
    expect(taskRubric.positioning.dimensions).toHaveLength(5);
    expect(taskRubric.storyDeck.dimensions).toHaveLength(5);
    expect(taskRubric.positioning.minimumEach).toBe(2);
    expect(taskRubric.positioning.minimumMean).toBe(3);
    expect(taskRubric.storyDeck.minimumEach).toBe(3);
    expect(taskRubric.productGate.minimumObservedParticipants).toBe(3);
  });
});
