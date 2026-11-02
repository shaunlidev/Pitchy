import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { fixture, httpFixture, reachDeck } from "./review-fixture";
import { advance, audit, prepare, readWorkflowReviewContext } from "./workflow";
import { recordReviewEvidence, reviewRecords, type ReviewPacket } from "./review";
import { assessTask } from "./verdict";
import { hashTaskValue, parseTaskBundle } from "./schema";
import { qualificationDeckControls, qualificationGoalUpgrade, qualificationPacket, qualificationReviewer, qualificationView, writeQualificationCase } from "../../../../scripts/qa-task-acceptance";

function guardFixture() {
  const { root } = fixture(), directory = join(root, "child-transport");
  mkdirSync(directory);
  const nonce = randomUUID(), sourceHash = "a".repeat(64), origin = "http://127.0.0.1:9";
  const transport = fileURLToPath(new URL("../../../../scripts/qa-task-acceptance-transport.mjs", import.meta.url));
  const environment = { PITCHROOM_RUNTIME: "postgres-fake", PITCHROOM_EVAL_SOURCE_HASH: sourceHash,
    PIT56_CHILD_NETWORK_GUARD: origin, PIT56_CHILD_GUARD_DIRECTORY: directory, PIT56_CHILD_GUARD_NONCE: nonce };
  // The original fetch is an observable sentinel, so a broken guard cannot
  // accidentally send a real network request during this subprocess check.
  const nativeFetch = "data:text/javascript," + encodeURIComponent("globalThis.transportCalls=[];globalThis.fetch=(input,options)=>{globalThis.transportCalls.push({input,options});return Promise.resolve(new Response('synthetic'));}");
  const launch = (entry: string[], loader: boolean, override: Partial<Record<keyof typeof environment, string>> = {}) => spawnSync(process.execPath,
    ["--import", nativeFetch, ...(loader ? ["--import", import.meta.resolve("tsx")] : []), "--import", transport, ...entry],
    { cwd: root, env: { ...environment, NODE_OPTIONS: "", ...override }, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 8192 });
  const run = (code: string, loader: boolean, override: Partial<Record<keyof typeof environment, string>> = {}) => launch(["--input-type=module", "-e", code], loader, override);
  const runWorker = () => launch([fileURLToPath(new URL("../../../../scripts/clarification-worker.ts", import.meta.url)), "--once"], true);
  return { root, directory, nonce, sourceHash, origin, run, runWorker };
}

it.each([false, true])("starts the standalone child guard and preserves its actual refusal chain (tsx=%s)", loader => {
  const f = guardFixture();
  const result = f.run(`
    import assert from 'node:assert/strict';
    assert.throws(() => fetch('https://pit56.invalid/refused'), /PIT56_CHILD_EXTERNAL_NETWORK_REFUSED/);
    assert.equal(globalThis.transportCalls.length, 0);
    await fetch('${f.origin}/read-only', { redirect: 'follow' });
    assert.deepEqual(globalThis.transportCalls, [{ input: '${f.origin}/read-only', options: { redirect: 'error' } }]);
    console.log(JSON.stringify({ entry: true, pid: process.pid }));
  `, loader);
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ entry: true, pid: result.pid });
  expect(readdirSync(f.directory).sort()).toEqual([`${result.pid}.attempts.jsonl`, `${result.pid}.ready.json`]);
  const ready = JSON.parse(readFileSync(join(f.directory, `${result.pid}.ready.json`), "utf8"));
  const seed = { pid: result.pid, nonce: f.nonce, sourceHash: f.sourceHash, origin: f.origin };
  const attempts = readFileSync(join(f.directory, `${result.pid}.attempts.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(attempts).toHaveLength(2);
  let previous = hashTaskValue(seed);
  attempts.forEach((event, sequence) => {
    const { hash, ...body } = event;
    expect(body).toEqual({ pid: result.pid, sequence, nonce: f.nonce, canary: sequence === 0, origin: "https://pit56.invalid", blockedBeforeNetwork: true, previous });
    expect(hash).toBe(hashTaskValue(body)); previous = hash;
  });
  expect(ready).toEqual({ ...seed, canaryHash: attempts[0].hash, externalDispatches: 0 });
});

it("loads the actual TypeScript worker and refuses missing database configuration after guard startup", () => {
  const f = guardFixture(), result = f.runWorker();
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(1); expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Clarification worker failed. Check database readiness and worker configuration.\n");
  expect(readdirSync(f.directory).sort()).toEqual([`${result.pid}.attempts.jsonl`, `${result.pid}.ready.json`]);
  const seed = { pid: result.pid, nonce: f.nonce, sourceHash: f.sourceHash, origin: f.origin };
  const canary = { pid: result.pid, sequence: 0, nonce: f.nonce, canary: true, origin: "https://pit56.invalid", blockedBeforeNetwork: true, previous: hashTaskValue(seed) };
  expect(JSON.parse(readFileSync(join(f.directory, `${result.pid}.attempts.jsonl`), "utf8"))).toEqual({ ...canary, hash: hashTaskValue(canary) });
  expect(JSON.parse(readFileSync(join(f.directory, `${result.pid}.ready.json`), "utf8"))).toEqual({ ...seed, canaryHash: hashTaskValue(canary), externalDispatches: 0 });
});

it("refuses an invalid child identity and symlinked evidence before writing ready", () => {
  const f = guardFixture();
  const invalid = f.run("throw new Error('entry must not run')", false, { PIT56_CHILD_GUARD_NONCE: "not-a-uuid" });
  expect(invalid.error).toBeUndefined(); expect(invalid.status).not.toBe(0); expect(invalid.stderr).toContain("PIT56_CHILD_GUARD_NONCE_INVALID");
  expect(readdirSync(f.directory)).toEqual([]);
  const link = join(f.root, "linked-transport"); symlinkSync(f.directory, link, "dir");
  const linked = f.run("throw new Error('entry must not run')", false, { PIT56_CHILD_GUARD_DIRECTORY: link });
  expect(linked.error).toBeUndefined(); expect(linked.status).not.toBe(0); expect(linked.stderr).toContain("EVIDENCE_PATH_SYMLINK");
  expect(readdirSync(f.directory)).toEqual([]);
});

it("retains an incomplete marker and stops the owned child when transport evidence cannot be kept", () => {
  const f = guardFixture();
  const result = f.run(`
    import { appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    appendFileSync(join(process.env.PIT56_CHILD_GUARD_DIRECTORY, process.pid + '.attempts.jsonl'), 'x'.repeat(8192));
    fetch('https://pit56.invalid/capacity-refusal');
    throw new Error('entry must not continue');
  `, false);
  expect(result.error).toBeUndefined(); expect(result.status).toBeNull(); expect(result.signal).toBe("SIGKILL");
  const marker = JSON.parse(readFileSync(join(f.directory, `${result.pid}.incomplete.json`), "utf8"));
  expect(marker).toEqual({ pid: result.pid, nonce: f.nonce, sourceHash: f.sourceHash, origin: f.origin,
    error: "Child transport evidence limit exceeded", lostAttemptHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

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

it("distinguishes minimum-page refusal from a missing Story block without mutating the adopted Deck", async () => {
  const f = await httpFixture(true), run = prepare(f.input), view = await reachDeck(run);
  const adopted = view.workspace.story?.versions.find(item => item.id === view.workspace.story?.head.storyId);
  if (!adopted || !view.workspace.story || !view.workspace.deck) throw new Error("Missing actual adopted Story and Deck");
  const input = { story: adopted.story, storyId: adopted.id, generation: view.workspace.story.head.generation, deck: view.workspace.deck.proposal };
  expect(input.deck.pages).toHaveLength(3);
  const before = hashTaskValue(input), controls = qualificationDeckControls(input);
  expect(controls.minimumPageRefusal).toEqual({ code: "too_small", origin: "array", path: ["pages"], minimum: 3, inclusive: true, actualPageCount: 2 });
  expect(controls.omittedBlockId).toBe(adopted.story.blocks[0]?.id);
  expect(input.deck.pages.some(page => page.id === controls.replacementPageId)).toBe(false);
  expect(controls.missingBlock).toContain("pages.0.block");
  expect(controls.changedBody).toEqual(["pages.0.body"]);
  expect(controls.inputHash).toBe(before); expect(hashTaskValue(input)).toBe(before);
}, 30_000);

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
