import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { inspectEvidenceCapacity, loadEvidencePolicy, recoverEvidenceLock, withEvidenceLock } from "./capacity";
import { appendTaskCheckpoint, appendTaskObservation, captureTaskSourceIdentity, createTaskSession, rebuildTaskLedgerReport, taskRuntimeIdentitySchema, verifyTaskSession } from "./session";
import { hashTaskValue } from "./schema";

const roots: string[] = [], children: ChildProcess[] = [];
const fixtureRoot = new URL("../../config/task-acceptance/pitchroom-r1/", import.meta.url);
const runtime = taskRuntimeIdentitySchema.parse({ web: { kind: "unknown", reason: "offline tool control, no service started" }, worker: { kind: "unknown", reason: "offline tool control, no worker started" } });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit51-session-"))); roots.push(root);
  for (const path of ["pitchroom-v6/evidence", "history", "pitchroom-app/.artifacts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "pitchroom-v6/manifest.json"), JSON.stringify({ evidencePolicy: { approvedCapBytes: 3_000_000, accountingPackageRoots: ["evidence"], accountingWorkspaceRoots: [{ path: "history", required: true }] } }));
  const policyInput = { repositoryRoot: root, recordDirectory: "pitchroom-app/.artifacts/task-sessions", referenceLinks: [], legacyWriters: "quiescent" };
  const policy = loadEvidencePolicy(policyInput);
  const lockHash = hashTaskValue("synthetic lock");
  const identity = { source: { head: "a".repeat(40), dirty: false, files: [{ path: "pitchroom-app/packages/example.ts", hash: hashTaskValue("synthetic source") }, { path: "pitchroom-app/pnpm-lock.yaml", hash: lockHash }], lockfileHash: lockHash }, runtime };
  const bundle = { taskCase: JSON.parse(readFileSync(new URL("case.json", fixtureRoot), "utf8")), oracle: JSON.parse(readFileSync(new URL("oracle.json", fixtureRoot), "utf8")), materialPackageText: readFileSync(new URL("materials.json", fixtureRoot), "utf8") };
  const input = { sessionId: randomUUID(), purpose: "tool_validation", maximumBytes: 1_000_000, identity, bundle };
  const ref = createTaskSession(policy, input);
  const sessionRoot = join(policy.recordRoot, ref.sessionId);
  return { root, policy, policyInput, input, ref, sessionRoot };
}
const checkpoint = (attemptId = "synthetic-first") => ({
  stage: "materials", attemptId, commandId: `cmd-${attemptId}`, projectId: "synthetic-project", revision: 1,
  startedAt: "2026-10-27T00:00:00Z", endedAt: "2026-10-27T00:00:01Z", parentCheckpointHashes: [],
  versionIds: { understanding: null, positioning: null, story: null, deck: null },
  model: "synthetic-no-provider", promptVersion: "offline-control-v1", runtime,
  usage: { kind: "unknown", reason: "No provider was called" }, request: { action: "synthetic-import" }, response: { kind: "transport_summary", status: "not_dispatched", httpStatus: null, providerStatus: null, observedModel: null },
  result: { kind: "unverified_record", data: { text: "Synthetic imported material; not a real R1 run" } },
});
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise<void>(done => child.once("exit", () => done())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PIT-51 append-only session integrity and recovery", () => {
  it("creates a private frozen session with code/lockfile/runtime identity and honest validation scope", () => {
    const f = fixture(), state = verifyTaskSession(f.policy, f.ref);
    expect(state.bundle.taskCase.status).toBe("frozen");
    expect(state.bundle.oracle.items).toHaveLength(14);
    expect(state.manifest.purpose).toBe("tool_validation");
    expect(state.manifest.identity).toEqual(f.input.identity);
    expect(state.committed.size).toBe(0);
    expect(lstatSync(f.sessionRoot).mode & 0o077).toBe(0);
    expect(lstatSync(join(f.sessionRoot, "manifest.json")).mode & 0o077).toBe(0);
    for (const name of ["inputs", "checkpoints", "claim-audit", "reviews", "observations", "failures", "verdict"]) expect(existsSync(join(f.sessionRoot, name))).toBe(true);
  });

  it("repeating initialization is idempotent and different intent cannot adopt its session id", () => {
    const f = fixture(), before = readFileSync(join(f.sessionRoot, "manifest.json"), "utf8");
    expect(createTaskSession(f.policy, f.input)).toEqual(f.ref);
    expect(readFileSync(join(f.sessionRoot, "manifest.json"), "utf8")).toBe(before);
    expect(() => createTaskSession(f.policy, { ...f.input, maximumBytes: 999_999 })).toThrow("SESSION_INITIALIZATION_CONFLICT");
  });

  it("preserves unknown usage and returns the same exact checkpoint for a repeated attempt", () => {
    const f = fixture(), input = checkpoint();
    const first = appendTaskCheckpoint(f.policy, f.ref, input), duplicate = appendTaskCheckpoint(f.policy, f.ref, input);
    expect(duplicate).toEqual({ ...first, replayed: true });
    const state = verifyTaskSession(f.policy, first.reference);
    expect(state.committed.size).toBe(1);
    expect(state.checkpoints.get(input.attemptId)?.value.input.usage).toEqual(input.usage);
    expect(() => appendTaskCheckpoint(f.policy, first.reference, { ...input, response: { ...input.response, status: "outcome_unknown" } })).toThrow("ATTEMPT_ID_CONFLICT");
  });

  it("requires a current journal head for a new attempt and existing parent checkpoint references", () => {
    const f = fixture(), first = appendTaskCheckpoint(f.policy, f.ref, checkpoint());
    expect(() => appendTaskCheckpoint(f.policy, f.ref, checkpoint("second"))).toThrow("SESSION_HEAD_CHANGED");
    expect(() => appendTaskCheckpoint(f.policy, first.reference, { ...checkpoint("second"), parentCheckpointHashes: [hashTaskValue("missing")] })).toThrow("UNKNOWN_PARENT_CHECKPOINT");
    const next = appendTaskCheckpoint(f.policy, first.reference, { ...checkpoint("second"), parentCheckpointHashes: [first.checkpointHash] });
    expect(verifyTaskSession(f.policy, next.reference).committed.size).toBe(2);
  });

  it("rejects output, input and manifest tampering instead of silently rehashing it", () => {
    const f = fixture(), first = appendTaskCheckpoint(f.policy, f.ref, checkpoint());
    const path = join(f.sessionRoot, "checkpoints", `${first.checkpointHash}.json`), original = readFileSync(path, "utf8");
    const edited = JSON.parse(original); edited.input.response.status = "outcome_unknown"; writeFileSync(path, JSON.stringify(edited));
    expect(() => verifyTaskSession(f.policy, first.reference)).toThrow("CHECKPOINT_TAMPERED");
    writeFileSync(path, original);
    const inputPath = join(f.sessionRoot, "inputs/bundle.json"), input = readFileSync(inputPath, "utf8");
    const changed = JSON.parse(input); changed.oracle.items[0].meaning = "changed rule"; writeFileSync(inputPath, JSON.stringify(changed));
    expect(() => verifyTaskSession(f.policy, first.reference)).toThrow("SESSION_INPUT_TAMPERED");
    writeFileSync(inputPath, input);
    const manifestPath = join(f.sessionRoot, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8")); manifest.maximumBytes += 1; writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyTaskSession(f.policy, first.reference)).toThrow("SESSION_MANIFEST_MISMATCH");
  });

  it("detects journal edits and rollback relative to the caller's confirmed anchor", () => {
    const f = fixture(), first = appendTaskCheckpoint(f.policy, f.ref, checkpoint());
    const path = join(f.sessionRoot, "events/000000000002.json"), original = readFileSync(path, "utf8"), event = JSON.parse(original);
    event.objectHash = hashTaskValue("changed"); writeFileSync(path, JSON.stringify(event));
    expect(() => verifyTaskSession(f.policy, first.reference)).toThrow("INVALID_JOURNAL_HASH_CHAIN");
    writeFileSync(path, original); rmSync(path);
    expect(() => verifyTaskSession(f.policy, first.reference)).toThrow("JOURNAL_ANCHOR_MISSING");
    expect(verifyTaskSession(f.policy, f.ref).uncommittedFiles).toContain(`checkpoints/${first.checkpointHash}.json`);
  });

  it("keeps partial files out of committed results and refuses links even in uncommitted data", () => {
    const f = fixture(); writeFileSync(join(f.sessionRoot, "events/.pending-crash"), "{partial", { mode: 0o600 });
    const state = verifyTaskSession(f.policy, f.ref);
    expect(state.events).toHaveLength(1); expect(state.uncommittedFiles).toContain("events/.pending-crash");
    symlinkSync(join(f.root, "history"), join(f.sessionRoot, "checkpoints/link"), "dir");
    expect(() => verifyTaskSession(f.policy, f.ref)).toThrow("SESSION_SYMLINK");
  });

  it("records observations/failures separately and never turns them into semantic pass", () => {
    const f = fixture();
    const observation = { id: "feedback", at: "2026-10-27T00:00:00Z", stage: "actual_use", attemptId: null, commandId: null, checkpointHash: null, kind: "observation", data: { assistance: "synthetic tool control" } };
    const first = appendTaskObservation(f.policy, f.ref, observation);
    expect(appendTaskObservation(f.policy, f.ref, observation)).toEqual(first);
    expect(() => appendTaskObservation(f.policy, first, { ...observation, data: { assistance: "different" } })).toThrow("OBSERVATION_ID_CONFLICT");
    const final = appendTaskObservation(f.policy, first, { id: "failed-1", at: observation.at, stage: "actual_use", attemptId: null, commandId: null, checkpointHash: null, kind: "failure", data: { explanation: "Synthetic failure retained" } });
    const before = readFileSync(join(f.sessionRoot, "manifest.json"), "utf8"), events = readdirSync(join(f.sessionRoot, "events")).map(name => readFileSync(join(f.sessionRoot, "events", name), "utf8"));
    const report = rebuildTaskLedgerReport(f.policy, final);
    expect(report.report).toMatchObject({ purpose: "tool_validation", observationCount: 2, semantic: "not_evaluated", userTask: "not_observed" });
    expect(rebuildTaskLedgerReport(f.policy, final).path).toBe(report.path);
    expect(readFileSync(join(f.sessionRoot, "manifest.json"), "utf8")).toBe(before);
    expect(readdirSync(join(f.sessionRoot, "events")).map(name => readFileSync(join(f.sessionRoot, "events", name), "utf8"))).toEqual(events);
  });

  it("refuses secrets, internal reasoning and credentials before publishing any checkpoint", () => {
    const f = fixture(), original = inspectEvidenceCapacity(f.policy).usedBytes;
    const forbidden = [{ authorization: "test-not-to-store" }, { reasoning_content: "private chain" }, { nested: { headers: { X: "value" } } }, { text: "sk-" + "x".repeat(32) }, { ["sk-" + "x".repeat(32)]: "credential in key" }];
    for (const request of forbidden) expect(() => appendTaskCheckpoint(f.policy, f.ref, { ...checkpoint(), request })).toThrow(/SENSITIVE_RECORD/);
    expect(() => appendTaskCheckpoint(f.policy, f.ref, { ...checkpoint(), request: { text: "human-secret-value" } }, ["human-secret-value"])).toThrow("SENSITIVE_RECORD_VALUE");
    expect(inspectEvidenceCapacity(f.policy).usedBytes).toBe(original);
    expect(readdirSync(join(f.sessionRoot, "checkpoints"))).toEqual([]);
  });

  it("refuses provider envelopes and typed reasoning items before storage", () => {
    const f = fixture(), marker = "SYNTHETIC_PRIVATE_REASONING";
    const envelope = { output: [{ type: "reasoning", summary: [{ type: "summary_text", text: marker }] }] };
    expect(() => appendTaskCheckpoint(f.policy, f.ref, { ...checkpoint(), response: envelope })).toThrow();
    for (const type of ["reasoning", "reasoning_text", "thinking", "redacted_thinking"]) {
      expect(() => appendTaskCheckpoint(f.policy, f.ref, { ...checkpoint(), request: { type, summary: marker } })).toThrow("INTERNAL_REASONING_RECORD");
      expect(() => appendTaskObservation(f.policy, f.ref, { id: "private", at: "2026-10-27T00:00:00Z", stage: "understanding", attemptId: null, commandId: null, checkpointHash: null, kind: "observation", data: { type, text: marker } })).toThrow("INTERNAL_REASONING_RECORD");
    }
    expect(readdirSync(join(f.sessionRoot, "checkpoints"))).toEqual([]);
    expect(verifyTaskSession(f.policy, f.ref).events).toHaveLength(1);
  });

  it("does not commit or erase old evidence when the per-session budget is exhausted", () => {
    const f = fixture(), before = readdirSync(join(f.sessionRoot, "events"));
    expect(() => appendTaskCheckpoint(f.policy, f.ref, { ...checkpoint(), request: { text: "x".repeat(600_000) } })).toThrow("EVIDENCE_CAPACITY");
    expect(readdirSync(join(f.sessionRoot, "events"))).toEqual(before);
    expect(readdirSync(join(f.sessionRoot, "checkpoints"))).toEqual([]);
    expect(verifyTaskSession(f.policy, f.ref).events).toHaveLength(1);
  });

  it("stores a schema-valid product output without claiming its semantics are reviewed", () => {
    const f = fixture();
    const output = { schemaVersion: 1, themes: [{ title: "Synthetic", summary: "Synthetic", claims: [{ statement: "A synthetic fact.", evidenceState: "supported", evidence: [{ sourceId: "synthetic-source", chunkId: "synthetic-chunk", quote: "A synthetic fact." }], userInputIds: [] }] }], gaps: [], nextQuestion: { question: "What is unknown?", whyItMatters: "Synthetic control", relatedThemeIndexes: [0] } };
    const result = appendTaskCheckpoint(f.policy, f.ref, { ...checkpoint(), stage: "understanding", result: { kind: "product_output", data: { stage: "understanding", output } } });
    expect(verifyTaskSession(f.policy, result.reference).committed.size).toBe(1);
    expect(rebuildTaskLedgerReport(f.policy, result.reference).report.semantic).toBe("not_evaluated");
    expect(() => appendTaskCheckpoint(f.policy, result.reference, { ...checkpoint("wrong-stage"), stage: "deck", result: { kind: "product_output", data: { stage: "understanding", output } } })).toThrow();
  });

  it("counts historical bytes and refuses the next commit when global capacity is exhausted", () => {
    const f = fixture(), used = inspectEvidenceCapacity(f.policy).usedBytes;
    writeFileSync(join(f.root, "history/external-evidence.json"), "x".repeat(3_000_000 - used - 2048));
    expect(inspectEvidenceCapacity(f.policy).remainingBytes).toBe(2048);
    expect(() => appendTaskCheckpoint(f.policy, f.ref, checkpoint())).toThrow("EVIDENCE_CAPACITY");
    expect(verifyTaskSession(f.policy, f.ref).events).toHaveLength(1);
    expect(existsSync(join(f.root, "history/external-evidence.json"))).toBe(true);
    expect(readdirSync(join(f.sessionRoot, "checkpoints"))).toEqual([]);
  });

  it("captures actual git, selected source and lockfile hashes without claiming a running build", () => {
    const repository = fileURLToPath(new URL("../../../../../", import.meta.url));
    const identity = captureTaskSourceIdentity(repository, ["pitchroom-app/packages/evals/src/task-acceptance/session.ts"]);
    expect(identity.head).toMatch(/^[a-f0-9]{40}$/); expect(typeof identity.dirty).toBe("boolean");
    expect(identity.files).toHaveLength(2);
    expect(identity.files.find(item => item.path === "pitchroom-app/pnpm-lock.yaml")?.hash).toBe(identity.lockfileHash);
    expect(() => captureTaskSourceIdentity(repository, ["pitchroom-app/.env.local"])).toThrow("INVALID_SOURCE_FINGERPRINT_PATH");
  });

  it("rejects two live processes competing for one capacity lock, then recovers a proven-dead owner", async () => {
    const f = fixture();
    const module = fileURLToPath(new URL("./capacity.ts", import.meta.url));
    const script = `import {loadEvidencePolicy,withEvidenceLock} from ${JSON.stringify(module)}; const p=loadEvidencePolicy(${JSON.stringify(f.policyInput)}); withEvidenceLock(p,()=>{process.send({kind:'locked'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`;
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" } }); children.push(child);
    await new Promise<void>((done, reject) => { child.once("message", () => done()); child.once("error", reject); child.once("exit", code => reject(new Error(`Child exited before lock: ${code}`))); });
    expect(() => withEvidenceLock(f.policy, () => 1)).toThrow("EVIDENCE_LOCKED");
    const owner = JSON.parse(readFileSync(join(f.policy.controlRoot, ".write-lock/owner.json"), "utf8"));
    child.kill("SIGKILL"); await new Promise<void>(done => child.once("exit", () => done()));
    expect(recoverEvidenceLock(f.policy, owner.token)).toMatchObject({ recoveredToken: owner.token });
    expect(withEvidenceLock(f.policy, () => 7)).toBe(7);
  });

  it("resumes interrupted initialization without replacing its original manifest or deleting pending bytes", async () => {
    const f = fixture(), input = { ...f.input, sessionId: randomUUID() };
    const capacityModule = fileURLToPath(new URL("./capacity.ts", import.meta.url)), sessionModule = fileURLToPath(new URL("./session.ts", import.meta.url));
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.linkSync; fs.linkSync=(source,dest)=>{if(String(dest).endsWith('/inputs/bundle.json')){process.send({kind:'before-input-commit'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return original(source,dest);}; syncBuiltinESMExports(); const {loadEvidencePolicy}=await import(${JSON.stringify(capacityModule)}); const {createTaskSession}=await import(${JSON.stringify(sessionModule)}); createTaskSession(loadEvidencePolicy(${JSON.stringify(f.policyInput)}),${JSON.stringify(input)});`;
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" } }); children.push(child);
    await new Promise<void>((done, reject) => { child.once("message", () => done()); child.once("error", reject); child.once("exit", code => reject(new Error(`Child exited before initialization fault: ${code}`))); });
    child.kill("SIGKILL"); await new Promise<void>(done => child.once("exit", () => done()));
    const root = join(f.policy.recordRoot, input.sessionId), originalManifest = readFileSync(join(root, "manifest.json"), "utf8");
    expect(existsSync(join(root, "inputs/bundle.json"))).toBe(false);
    const owner = JSON.parse(readFileSync(join(f.policy.controlRoot, ".write-lock/owner.json"), "utf8")); recoverEvidenceLock(f.policy, owner.token);
    const ref = createTaskSession(f.policy, input), verified = verifyTaskSession(f.policy, ref);
    expect(readFileSync(join(root, "manifest.json"), "utf8")).toBe(originalManifest);
    expect(verified.events).toHaveLength(1);
    expect(verified.uncommittedFiles.some(path => path.startsWith("inputs/.pending-"))).toBe(true);
  });

  it("SIGKILL after object publication preserves the prior checkpoint and replays the same attempt", async () => {
    const f = fixture(), first = appendTaskCheckpoint(f.policy, f.ref, checkpoint("committed-before-crash"));
    const next = checkpoint("interrupted-attempt"), capacityModule = fileURLToPath(new URL("./capacity.ts", import.meta.url)), sessionModule = fileURLToPath(new URL("./session.ts", import.meta.url));
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.linkSync; fs.linkSync=(source,dest)=>{if(String(dest).includes('/events/')){process.send({kind:'before-commit'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return original(source,dest);}; syncBuiltinESMExports(); const {loadEvidencePolicy}=await import(${JSON.stringify(capacityModule)}); const {appendTaskCheckpoint}=await import(${JSON.stringify(sessionModule)}); appendTaskCheckpoint(loadEvidencePolicy(${JSON.stringify(f.policyInput)}),${JSON.stringify(first.reference)},${JSON.stringify(next)});`;
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" } }); children.push(child);
    await new Promise<void>((done, reject) => { child.once("message", () => done()); child.once("error", reject); child.once("exit", code => reject(new Error(`Child exited before fault point: ${code}`))); });
    child.kill("SIGKILL"); await new Promise<void>(done => child.once("exit", () => done()));
    const interrupted = verifyTaskSession(f.policy, first.reference);
    expect(interrupted.committed.size).toBe(1);
    expect(interrupted.checkpoints.get(next.attemptId)).toBeDefined();
    expect(interrupted.uncommittedFiles.length).toBeGreaterThan(0);
    const owner = JSON.parse(readFileSync(join(f.policy.controlRoot, ".write-lock/owner.json"), "utf8")); recoverEvidenceLock(f.policy, owner.token);
    const resumed = appendTaskCheckpoint(f.policy, first.reference, next), verified = verifyTaskSession(f.policy, resumed.reference);
    expect(verified.committed.size).toBe(2);
    expect(verified.uncommittedFiles.some(path => path.startsWith("events/.pending-"))).toBe(true);
    expect(verified.committed.has(first.checkpointHash)).toBe(true);
    expect(appendTaskCheckpoint(f.policy, resumed.reference, next).replayed).toBe(true);
  });
});
