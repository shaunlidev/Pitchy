import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { fixture, httpFixture, humanDecision } from "./review-fixture";
import { advance, audit, prepare, readWorkflowReviewContext, recordDecision } from "./workflow";
import { issueReviewPacket, recordReviewEvidence, calibrationBank, inventoryReviewFields, reviewRecords, packetFindings, validSpan, reviewEvidenceSources, targetAt } from "./review";
import { loadEvidencePolicy, recoverEvidenceLock } from "./capacity";
import { assessTask } from "./verdict";
import { runTaskAcceptanceCLI } from "./cli";
import { hashTaskValue } from "./schema";

const humanAuthority = () => ({ kind: "review_authority", id: "authority-1", at: "2026-10-30T00:00:00Z", operatorEvidenceRef: "operator:explicit-role-attestation", mode: "assisted_self_test", actors: [{ actorId: "reviewer", personId: "person-1", role: "human", permissions: ["review", "material_owner", "adjudicate"] }] });
it("records authority idempotently, preserves workflow audit, and recovers a committed review before anchor publication", () => {
  const f = fixture(), run = prepare(f.input), original = readFileSync(run.referenceFile);
  const first = recordReviewEvidence(run, humanAuthority());
  const folder = dirname(run.referenceFile), anchor = readdirSync(folder).filter(name => name.startsWith("anchor-")).sort().at(-1);
  expect(anchor).toBeDefined(); if (!anchor) throw new Error("Missing anchor");
  const bytes = readFileSync(join(folder, anchor)); unlinkSync(join(folder, anchor));
  const repeated = recordReviewEvidence(run, humanAuthority());
  expect(repeated).toEqual(first); expect(readFileSync(join(folder, anchor))).toEqual(bytes);
  expect(readWorkflowReviewContext(run).records).toHaveLength(1); expect(readFileSync(run.referenceFile)).toEqual(original);
  expect(audit(run)).toMatchObject({ execution: "prepared", semantic: "not_evaluated", userTask: "not_observed" });
  expect(() => recordReviewEvidence(run, { ...humanAuthority(), operatorEvidenceRef: "other" })).toThrow("REVIEW_AUTHORITY_FROZEN");
});
it("actual CLI derives the complete review template only from a committed workflow checkpoint", async () => {
  const f = await httpFixture(), run = prepare(f.input); recordReviewEvidence(run, humanAuthority());
  const progress = await advance(run); if (progress.kind !== "awaiting_human") throw new Error("Missing boundary");
  let output = "";
  expect(await runTaskAcceptanceCLI(["review-packet", "--run", run.referenceFile, "--checkpoint", progress.checkpointHash, "--actor", "reviewer"], text => { output += text; })).toBe(0);
  const template = z.object({ result: z.object({ binding: z.object({ checkpointHash: z.string() }), fields: z.array(z.object({ pointer: z.string(), classification: z.string() })) }) }).parse(JSON.parse(output)).result;
  expect(template.binding.checkpointHash).toBe(progress.checkpointHash); expect(template.fields.some(item => item.classification === "prose")).toBe(true);
  expect(() => issueReviewPacket(run, { checkpointHash: "a".repeat(64), actorId: "reviewer" })).toThrow("REVIEW_CHECKPOINT_NOT_IN_WORKFLOW");
  expect(() => issueReviewPacket(run, { checkpointHash: progress.checkpointHash, actorId: "generator" })).toThrow("REVIEW_ACTOR_NOT_AUTHORIZED");
}, 20000);

it("enumerates numeric facts and unknown schema strings instead of silently exempting them", () => {
  const fields = inventoryReviewFields({ schemaVersion: 1, result: { percent: 20, achieved: false, newStatement: "Claim", id: "Sentence disguised as id" } });
  expect(fields).toHaveLength(5);
  expect(fields.filter(item => item.classification === "prose").map(item => item.pointer)).toEqual(["/result/percent", "/result/achieved", "/result/newStatement", "/result/id"]);
});
async function reviewedFixture() {
  const f = await httpFixture(), run = prepare(f.input);
  const roles = humanAuthority(); roles.actors.push({ actorId: "reviewer-2", personId: "person-2", role: "human", permissions: ["review"] });
  roles.actors.push({ actorId: "alias", personId: "person-1", role: "human", permissions: ["review"] });
  recordReviewEvidence(run, roles);
  const progress = await advance(run); if (progress.kind !== "awaiting_human") throw new Error("Missing boundary");
  const calibrate = (actorId: string, suffix = "", good = true) => ({ kind: "review_calibration", id: `calibration-${actorId}${suffix}`, at: "2026-10-30T00:00:00Z", actorId,
    authorityHash: hashTaskValue(roles), bankHash: hashTaskValue(calibrationBank), answers: calibrationBank.map(item => ({ caseId: item.id, supportVerdict: good ? item.expected : "direct_support", reason: "Explicit synthetic calibration answer." })) });
  for (const actor of roles.actors) recordReviewEvidence(run, calibrate(actor.actorId));
  const packet = (actorId: string, suffix = "") => {
    const template = issueReviewPacket(run, { checkpointHash: progress.checkpointHash, actorId });
    return { kind: "review_packet", id: `packet-${actorId}${suffix}`, at: "2026-10-30T00:00:00Z", actorId, authorityHash: template.authorityHash, calibrationHash: hashTaskValue(calibrate(actorId)), binding: template.binding,
      fields: template.fields.filter(item => item.classification === "prose").map(item => ({ kind: "no_factual_claim", pointer: item.pointer, valueHash: item.valueHash, readWholeField: true, reason: "Synthetic review disposition; not a claim about real output quality." })),
      oracle: template.oracle.map(item => ({ oracleId: item.id, verdict: "preserved", fieldPointers: [template.fields[0]?.pointer ?? "/"], reason: "Synthetic oracle review." })), scores: [], directionDifference: "", assistance: [] };
  };
  return { ...f, run, packet, calibrate, progress };
}
it("accepts whole bound packets while rejecting missing fields, oracle omissions, stale hashes and person aliases", async () => {
  const f = await reviewedFixture(), original = f.packet("reviewer");
  expect(() => recordReviewEvidence(f.run, { ...original, fields: [] })).toThrow("REVIEW_EMPTY_FIELDS_REASON_REQUIRED");
  expect(() => recordReviewEvidence(f.run, { ...original, fields: original.fields.slice(1) })).toThrow("REVIEW_FIELD_COVERAGE");
  expect(() => recordReviewEvidence(f.run, { ...original, oracle: original.oracle.slice(1) })).toThrow("REVIEW_ORACLE_COVERAGE");
  expect(() => recordReviewEvidence(f.run, { ...original, binding: { ...original.binding, outputHash: "a".repeat(64) } })).toThrow("REVIEW_BINDING_MISMATCH");
  const saved = recordReviewEvidence(f.run, original); expect(recordReviewEvidence(f.run, original)).toEqual(saved);
  expect(() => recordReviewEvidence(f.run, f.packet("alias"))).toThrow("REVIEW_PERSON_ALREADY_RECORDED");
  expect(() => recordReviewEvidence(f.run, { ...original, id: "replacement" })).toThrow("REVIEW_PERSON_ALREADY_RECORDED");
  expect(reviewRecords(readWorkflowReviewContext(f.run)).filter(item => item.kind === "review_packet")).toHaveLength(1);
}, 20000);
it("retains failed calibration without allowing it to certify reviews and rejects generator authority", async () => {
  const f = await reviewedFixture(), failed = f.calibrate("reviewer", "-failed", false); recordReviewEvidence(f.run, failed);
  expect(() => recordReviewEvidence(f.run, { ...f.packet("reviewer"), calibrationHash: hashTaskValue(failed) })).toThrow("REVIEW_CALIBRATION_REQUIRED");
  expect(reviewRecords(readWorkflowReviewContext(f.run)).some(item => item.kind === "review_calibration" && item.id === failed.id)).toBe(true);
  const fresh = fixture(), run = prepare(fresh.input), role = humanAuthority(); const firstActor = role.actors[0]; if (!firstActor) throw new Error("Missing actor"); firstActor.role = "generator";
  expect(() => recordReviewEvidence(run, role)).toThrow(); expect(readWorkflowReviewContext(run).records).toHaveLength(0);
}, 20000);
it.each(["critical", "noncritical"])("preserves opposing %s judgments and requires full authorized adjudication references", async severity => {
  const f = await reviewedFixture(), template = issueReviewPacket(f.run, { checkpointHash: f.progress.checkpointHash, actorId: "reviewer" });
  const field = template.fields.find(item => item.classification === "prose" && typeof item.value === "string" && item.value.length);
  if (!field || typeof field.value !== "string") throw new Error("Missing text");
  const fieldText = field.value;
  const source = readWorkflowReviewContext(f.run).bundle.fixture.sources[0]; if (!source) throw new Error("Missing source");
  const make = (actorId: string, support: "contradicted" | "direct_support") => {
    const packet = f.packet(actorId), judgment = { preserved: true, reason: "Synthetic boundary judgment." };
    return { ...packet, fields: packet.fields.map(item => item.pointer !== field.pointer ? item : { kind: "claims", pointer: field.pointer, valueHash: field.valueHash, readWholeField: true, allKeyClaimsExtracted: true,
      claims: [{ claimId: `claim-${actorId}`, checkpointHash: template.binding.checkpointHash, location: { pointer: field.pointer, start: 0, end: fieldText.length }, text: fieldText, nature: "fact", evidenceRefs: [{ sourceId: source.id, sourceHash: hashTaskValue(source), quote: source.material, start: 0, end: source.material.length }], supportVerdict: support, conditions: judgment, time: judgment, attribution: judgment, certainty: judgment, severity, reviewer: actorId, reason: `Synthetic ${support} position.` }] }) };
  };
  const a = make("reviewer", "contradicted"), b = make("reviewer-2", "direct_support");
  recordReviewEvidence(f.run, a); expect(assessTask(f.run)).toMatchObject({ semantic: { kind: "fail" } });
  recordReviewEvidence(f.run, b); expect(assessTask(f.run)).toMatchObject({ semantic: { kind: "disputed" } });
  const packets = reviewRecords(readWorkflowReviewContext(f.run)).filter(item => item.kind === "review_packet");
  const first = packets[0]; if (!first || first.kind !== "review_packet") throw new Error("Missing packet");
  const key = packetFindings(first, template).find(item => item.verdict === "violated")?.key; if (!key) throw new Error("Missing finding");
  const resolution = { kind: "review_adjudication", id: "resolve-1", at: "2026-10-30T00:00:00Z", actorId: "reviewer", authorityHash: template.authorityHash, binding: template.binding, findingKey: key, packetHashes: packets.map(hashTaskValue), verdict: "violated", reason: "Material owner preserves both reasons and confirms the false claim." };
  expect(() => recordReviewEvidence(f.run, { ...resolution, packetHashes: [hashTaskValue(a)] })).toThrow("REVIEW_ADJUDICATION_MISSING_REASON");
  expect(() => recordReviewEvidence(f.run, { ...resolution, actorId: "reviewer-2" })).toThrow("REVIEW_ACTOR_NOT_AUTHORIZED");
  recordReviewEvidence(f.run, resolution); expect(assessTask(f.run)).toMatchObject({ semantic: { kind: "fail" } }); expect(reviewRecords(readWorkflowReviewContext(f.run)).filter(item => item.kind === "review_packet")).toHaveLength(2);
}, 20000);

it("binds UTF-16 spans without splitting surrogate pairs or accepting code-point offsets", () => {
  const text = "A😀证据";
  expect(validSpan(text, 1, 3, "😀")).toBe(true);
  expect(validSpan(text, 3, 5, "证据")).toBe(true);
  expect(validSpan(text, 1, 2, text.slice(1, 2))).toBe(false);
  expect(validSpan(text, 2, 3, text.slice(2, 3))).toBe(false);
  expect(validSpan(text, 1, 2, "😀")).toBe(false);
  expect(validSpan(text, -1, 1, "A")).toBe(false);
  expect(validSpan(text, 0.5, 1, "A")).toBe(false);
});

it("rejects secret-bearing review input before retaining any review payload", () => {
 const f = fixture(), run = prepare(f.input);
 expect(() => recordReviewEvidence(run, { ...humanAuthority(), operatorEvidenceRef: "sk-" + "x".repeat(32) })).toThrow("SENSITIVE_RECORD_VALUE");
 expect(readWorkflowReviewContext(run).records).toHaveLength(0);
});

it("recovers an actual process death after review commit and before anchor publication", async () => {
  const f = fixture(), run = prepare(f.input), input = join(f.root, "authority.json"), hook = join(f.root, "crash.mjs");
  writeFileSync(input, JSON.stringify(humanAuthority()));
  writeFileSync(hook, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.linkSync; fs.linkSync=function(source,target,...args){ if(String(target).includes('/anchor-'))process.kill(process.pid,'SIGKILL'); return original.call(this,source,target,...args); }; syncBuiltinESMExports();`);
  await expect(promisify(execFile)(process.execPath, ["--import", "tsx", "--import", hook, "src/task-acceptance/cli.ts", "review-record", "--run", run.referenceFile, "--file", input], { timeout: 10000 })).rejects.toMatchObject({ signal: "SIGKILL" });
  expect(readWorkflowReviewContext(run).records).toHaveLength(1);
  const retry = () => promisify(execFile)(process.execPath, ["--import", "tsx", "src/task-acceptance/cli.ts", "review-record", "--run", run.referenceFile, "--file", input], { timeout: 10000 });
  await expect(retry()).rejects.toMatchObject({ stdout: expect.stringContaining("EVIDENCE_LOCKED") });
  const policy = loadEvidencePolicy(JSON.parse(readFileSync(f.input.accountingPolicyFile, "utf8")));
  const owner = z.object({ token: z.string() }).parse(JSON.parse(readFileSync(join(policy.controlRoot, ".write-lock/owner.json"), "utf8")));
  expect(recoverEvidenceLock(policy, owner.token).reason).toBe("local_owner_process_no_longer_exists");
  const repeated = await retry();
  expect(JSON.parse(repeated.stdout).result.recordHash).toBe(hashTaskValue(humanAuthority()));
  expect(readWorkflowReviewContext(run).records).toHaveLength(1); expect(audit(run).integrity).toBe("valid");
}, 20000);
it("keeps separate actors' concurrent CLI writes without dropping accepted evidence", async () => {
  const f = fixture(), run = prepare(f.input), roles = humanAuthority();
  roles.actors.push({ actorId: "second", personId: "person-2", role: "human", permissions: ["review"] }); recordReviewEvidence(run, roles);
  const paths = roles.actors.map(actor => {
    const input = { kind: "review_calibration", id: `calibration-${actor.actorId}`, at: "2026-10-30T00:00:00Z", actorId: actor.actorId, authorityHash: hashTaskValue(roles), bankHash: hashTaskValue(calibrationBank), answers: calibrationBank.map(item => ({ caseId: item.id, supportVerdict: item.expected, reason: "Synthetic calibration." })) };
    const path = join(f.root, `${actor.actorId}.json`); writeFileSync(path, JSON.stringify(input)); return path;
  });
  const call = (path: string) => promisify(execFile)(process.execPath, ["--import", "tsx", "src/task-acceptance/cli.ts", "review-record", "--run", run.referenceFile, "--file", path], { timeout: 10000 });
  const results = await Promise.allSettled(paths.map(call)); expect(results.some(result => result.status === "fulfilled")).toBe(true);
  for (const path of paths) await call(path);
  expect(reviewRecords(readWorkflowReviewContext(run)).filter(item => item.kind === "review_calibration")).toHaveLength(2);
}, 20000);

it("exposes exact resolved retraction words without upgrading the statement to a verified fact", async () => {
  const f = await reviewedFixture(), question = f.progress.choices[0]; if (!question) throw new Error("Missing question");
  const words = "I withdraw the earlier attribution: the procurement owner has not confirmed agreement.";
  const decision = humanDecision(f.progress, { kind: "answer_clarification", taskKey: question.key, originalWords: words });
  await recordDecision({ run: f.run, decision });
  const context = readWorkflowReviewContext(f.run), sources = reviewEvidenceSources(context), source = sources.find(item => item.sourceId === `decision:${decision.decisionId}`);
  if (!source) throw new Error("Missing committed user statement");
  expect(source).toMatchObject({ nature: "user_statement", text: words, action: "answer_clarification" });
  expect(reviewEvidenceSources({ ...context, resolvedDecisionIds: [] }).some(item => item.sourceId === source.sourceId)).toBe(false);
  const target = issueReviewPacket(f.run, { checkpointHash: f.progress.checkpointHash, actorId: "reviewer" });
  const field = target.fields.find(item => typeof item.value === "string" && item.classification === "prose");
  if (!field || typeof field.value !== "string") throw new Error("Missing claim field");
  const base = f.packet("reviewer"), kept = { preserved: true, reason: "Synthetic judgment." };
  const claim = { claimId: "attribution", checkpointHash: target.binding.checkpointHash, location: { pointer: field.pointer, start: 0, end: field.value.length }, text: field.value, nature: "reported", evidenceRefs: [{ sourceId: source.sourceId, sourceHash: source.sourceHash, quote: words, start: 0, end: words.length }], supportVerdict: "direct_support", conditions: kept, time: kept, attribution: { preserved: false, reason: "The user explicitly withdrew agreement attribution." }, certainty: kept, severity: "critical", reviewer: "reviewer", reason: "Exact quote exists but does not justify a consent claim." };
  const make = (value: typeof claim) => ({ ...base, fields: base.fields.map(item => item.pointer === field.pointer ? { pointer: item.pointer, valueHash: item.valueHash, readWholeField: true, kind: "claims", allKeyClaimsExtracted: true, claims: [value] } : item) });
  expect(() => recordReviewEvidence(f.run, make({ ...claim, nature: "fact" }))).toThrow("REVIEW_USER_STATEMENT_NOT_VERIFIED_FACT");
  expect(() => recordReviewEvidence(f.run, make({ ...claim, evidenceRefs: [{ ...claim.evidenceRefs[0]!, quote: "Changed quote" }] }))).toThrow("REVIEW_SOURCE_QUOTE");
  recordReviewEvidence(f.run, make(claim));
  expect(assessTask(f.run)).toMatchObject({ semantic: { kind: "fail" } });
  const emptyMaterials = context.snapshots.find(snapshot => snapshot.input.stage === "materials" && !snapshot.workspace.sources.length);
  if (!emptyMaterials) throw new Error("Missing actual initial checkpoint");
  expect(() => targetAt(context, emptyMaterials.checkpointHash)).toThrow("REVIEW_OUTPUT_MISSING");
}, 20000);
