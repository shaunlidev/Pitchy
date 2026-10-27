import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { readPositioning, storyToDeck, workspaceStateSchema } from "@pitchroom/domain";
import { GET, POST } from "../../../../apps/web/app/api/workspace/route";
import { healthResponse } from "../../../../apps/web/app/api/health/route";
import { evaluationInstance } from "../../../../apps/web/lib/evaluation-instance";
import { addFixtureMaterial, readFixtureState, resetFixtureState } from "../../../../apps/web/lib/fixture-store";
import { hashTaskBytes, hashTaskValue } from "./schema";
import { advance, audit, prepare, recordDecision, report } from "./workflow";
import { loadEvidencePolicy } from "./capacity";
import { appendTaskCheckpoint, appendTaskObservation, verifyTaskSession } from "./session";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit53-local-"))); roots.push(root);
  for (const path of ["pitchroom-v6/evidence", "history", "pitchroom-app/.artifacts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "pitchroom-v6/manifest.json"), JSON.stringify({ evidencePolicy: { approvedCapBytes: 3_000_000, accountingPackageRoots: ["evidence"], accountingWorkspaceRoots: [{ path: "history", required: true }] } }));
  const accountingPolicyFile = join(root, "accounting.json"), launchReceiptFile = join(root, "launch.json");
  writeFileSync(accountingPolicyFile, JSON.stringify({ repositoryRoot: root, recordDirectory: "pitchroom-app/.artifacts/workflows", referenceLinks: [], legacyWriters: "quiescent" }));
  writeFileSync(launchReceiptFile, JSON.stringify({ baseURL: "http://127.0.0.1:3153/", instance: { kind: "isolated_evaluation_instance", instanceId: randomUUID(), sourceFingerprint: "a".repeat(64), targetFingerprint: "b".repeat(64), runtime: "fixture", projectSelector: "atelier", pid: process.pid }, projectId: "00000000-0000-4000-8000-000000000001", timeoutMs: 1000, maximumResponseBytes: 1_000_000 }));
  const sourceRepository = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" }).trim();
  const input = { caseDirectory: fileURLToPath(new URL("../../config/task-acceptance/pitchroom-r1/", import.meta.url)), accountingPolicyFile, launchReceiptFile, sourceRepository, sessionId: randomUUID(), maximumBytes: 1_000_000, purpose: "tool_validation" };
  return { root, input, sessionRoot: join(root, "pitchroom-app/.artifacts/workflows", input.sessionId) };
}
function files(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name); if (item.isDirectory()) walk(path); else entries[path] = hashTaskBytes(readFileSync(path));
    }
  }; walk(root); return entries;
}
async function httpFixture(fullTask = false, afterPost?: () => Promise<void>) {
  const f = fixture();
  if (fullTask) {
    // Separate explicit budget for this multi-revision control, fixed before session creation.
    const manifest = JSON.parse(readFileSync(join(f.root, "pitchroom-v6/manifest.json"), "utf8"));
    manifest.evidencePolicy.approvedCapBytes = 32_000_000;
    writeFileSync(join(f.root, "pitchroom-v6/manifest.json"), JSON.stringify(manifest));
    f.input.maximumBytes = 24_000_000;
  }
  vi.stubEnv("PITCHROOM_RUNTIME", "fixture"); vi.stubEnv("PITCHROOM_EVAL_INSTANCE_ID", randomUUID()); vi.stubEnv("PITCHROOM_EVAL_SOURCE_HASH", "c".repeat(64));
  // The existing reset helper assigns fresh fields but does not remove optional heads.
  // Clear only this test-owned singleton before resetting; never reuse a prior test's project.
  const singleton: unknown = Reflect.get(globalThis, "__pitchroomFixture");
  if (singleton && typeof singleton === "object") for (const key of ["deck", "positioning", "currentVersionId"]) Reflect.deleteProperty(singleton, key);
  resetFixtureState();
  const instance = evaluationInstance(); if (instance.kind !== "enabled") throw new Error("Missing test identity");
  const commands: unknown[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const parts: Buffer[] = []; for await (const part of incoming) parts.push(Buffer.from(part));
      const headers = new Headers(); for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(key, value);
      const body = Buffer.concat(parts);
      const request = new Request(`http://127.0.0.1${incoming.url}`, { headers, method: incoming.method, ...(incoming.method === "POST" ? { body } : {}) });
      let response: Response;
      if (incoming.url === "/api/health") response = await healthResponse();
      else if (incoming.method === "POST") { commands.push(JSON.parse(body.toString("utf8"))); response = await POST(request); await afterPost?.(); }
      else response = await GET(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch { outgoing.destroy(); }
  });
  servers.push(server);
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test listener");
  const receipt = JSON.parse(readFileSync(f.input.launchReceiptFile, "utf8")); receipt.baseURL = `http://127.0.0.1:${address.port}/`; receipt.instance = instance.identity;
  writeFileSync(f.input.launchReceiptFile, JSON.stringify(receipt));
  return { ...f, commands };
}

it("prepares a frozen private run locally with no HTTP and keeps semantic/use verdicts unobserved", () => {
  const f = fixture(), fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected HTTP"));
  const run = prepare(f.input), result = audit(run);
  expect(fetch).not.toHaveBeenCalled();
  expect(result).toMatchObject({ kind: "workflow_integrity_only", execution: "prepared", nextStage: "materials", semantic: "not_evaluated", userTask: "not_observed", checkpointCount: 0, purpose: "tool_validation" });
  expect(result.budget.sessionBytes + result.budget.maximumHandleBytes).toBe(f.input.maximumBytes);
  expect(result.reference.sequence).toBe(2);
});

it("repeat prepare and read-only audit/report preserve every original byte", () => {
  const f = fixture(), run = prepare(f.input), before = files(join(f.root, "pitchroom-app/.artifacts"));
  expect(prepare(f.input)).toEqual(run); expect(report(run)).toEqual(audit(run));
  expect(files(join(f.root, "pitchroom-app/.artifacts"))).toEqual(before);
});

it("does not silently rebind an existing run to a changed service receipt", () => {
  const f = fixture(), run = prepare(f.input), before = files(join(f.root, "pitchroom-app/.artifacts"));
  const receipt = JSON.parse(readFileSync(f.input.launchReceiptFile, "utf8")); receipt.instance.instanceId = randomUUID();
  writeFileSync(f.input.launchReceiptFile, JSON.stringify(receipt));
  expect(() => prepare(f.input)).toThrow("WORKFLOW_CONFIGURATION_CHANGED");
  expect(files(join(f.root, "pitchroom-app/.artifacts"))).toEqual(before);
  expect(audit(run).integrity).toBe("valid");
});

it("refuses locator tampering, symlinks and insecure reference permissions", () => {
  const f = fixture(), run = prepare(f.input), original = readFileSync(run.referenceFile);
  const locator = JSON.parse(original.toString("utf8")); locator.launchReceipt.projectId = randomUUID();
  writeFileSync(run.referenceFile, JSON.stringify(locator)); expect(() => audit(run)).toThrow("WORKFLOW_CONFIGURATION_CHANGED");
  writeFileSync(run.referenceFile, original);
  const link = join(f.root, "reference-link.json"); symlinkSync(run.referenceFile, link);
  expect(() => audit({ referenceFile: link })).toThrow("EVIDENCE_PATH_SYMLINK"); unlinkSync(link);
  chmodSync(run.referenceFile, 0o644); expect(() => audit(run)).toThrow("WORKFLOW_INSECURE_REFERENCE");
});

it("the separately retained latest anchor detects session-only journal rollback", () => {
  const f = fixture(), run = prepare(f.input);
  unlinkSync(join(f.sessionRoot, "events/000000000002.json"));
  expect(() => audit(run)).toThrow("JOURNAL_ANCHOR_MISSING");
});

it("retains interrupted handle publications and reports them without deleting or treating them as committed", () => {
  const f = fixture(), run = prepare(f.input), pending = join(dirname(run.referenceFile), ".pending-synthetic-interruption");
  writeFileSync(pending, "synthetic interrupted bytes", { mode: 0o600 });
  expect(audit(run).pendingHandleFiles).toEqual([".pending-synthetic-interruption"]);
  expect(readFileSync(pending, "utf8")).toBe("synthetic interrupted bytes");
});

it("rejects a changed frozen case before creating the session", () => {
  const f = fixture(), copy = join(f.root, "case"); cpSync(f.input.caseDirectory, copy, { recursive: true });
  const input = JSON.parse(readFileSync(join(copy, "case.json"), "utf8")); input.spec.caseVersion = "changed"; writeFileSync(join(copy, "case.json"), JSON.stringify(input));
  expect(() => prepare({ ...f.input, caseDirectory: copy })).toThrow("CASE_OR_RULE_VERSION_MISMATCH");
  expect(existsSync(f.sessionRoot)).toBe(false);
});

it("advances actual isolated product HTTP only to Understanding review and preserves its gate on repeat", async () => {
  const f = await httpFixture(), run = prepare(f.input);
  const viewSchema = z.object({ kind: z.literal("awaiting_human"), step: z.literal("understanding_review"), checkpointHash: z.string(), capability: z.string(), workspace: workspaceStateSchema });
  const view = viewSchema.parse(await advance(run));
  expect(view.workspace.project.phase).toBe("review_required");
  expect(view.workspace.sources.filter(item => item.kind === "file")).toHaveLength(5);
  expect(view.workspace.sources.filter(item => item.kind === "brief")).toHaveLength(1);
  expect(view.workspace.currentVersionId).toBeDefined();
  const bodies = z.array(z.object({ action: z.string() })).parse(f.commands);
  expect(bodies.map(item => item.action)).toEqual(["add_material", "add_material", "add_material", "add_material", "add_material", "save_brief", "run"]);
  expect(JSON.stringify(f.commands)).not.toContain('"oracle"'); expect(JSON.stringify(f.commands)).not.toContain('"rubricHash"');
  const repeated = viewSchema.parse(await advance(run)); expect(repeated).toEqual(view); expect(f.commands).toHaveLength(7);
  expect(audit(run)).toMatchObject({ execution: "awaiting_human", nextStage: "understanding_review", semantic: "not_evaluated", userTask: "not_observed", checkpointCount: 8 });
}, 30000);

const humanViewSchema = z.object({ kind: z.literal("awaiting_human"), step: z.string(), checkpointHash: z.string(), capability: z.string(), workspace: workspaceStateSchema, choices: z.array(z.object({ key: z.string() })) });
function advanceProcess(referenceFile: string, crash?: { sessionRoot: string; kind: string }, args = ["advance", "--run", referenceFile]) {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const injected = crash ? `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const root=${JSON.stringify(crash.sessionRoot)}, handle=${JSON.stringify(dirname(referenceFile))}, kind=${JSON.stringify(crash.kind)};
    const remove=fs.rmdirSync;
    fs.rmdirSync=function(path,...rest){ const result=remove.call(fs,path,...rest);
      if(String(path).endsWith('/.write-lock')) {
        const events=fs.readdirSync(root+'/events').sort();
        const anchors=fs.readdirSync(handle).filter(n=>n.startsWith('anchor-')).sort();
        const anchor=JSON.parse(fs.readFileSync(handle+'/'+anchors.at(-1),'utf8'));
        const event=JSON.parse(fs.readFileSync(root+'/events/'+events.at(-1),'utf8'));
        const found=fs.readdirSync(root+'/observations').some(n=>JSON.parse(fs.readFileSync(root+'/observations/'+n,'utf8')).data?.kind===kind);
        if(found && anchor.sequence===event.sequence) process.kill(process.pid,'SIGKILL');
      } return result;
    }; syncBuiltinESMExports();
    const {runTaskAcceptanceCLI}=await import(${JSON.stringify(new URL("./cli.ts", import.meta.url).href)});
    process.exitCode=await runTaskAcceptanceCLI(${JSON.stringify(args)});` : null;
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ...(injected ? ["--input-type=module", "--eval", injected] : [cli, ...args])], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}
it.each(["workflow_operation", "workspace_command_outcome"])("resumes a killed CLI after anchored %s without repeating a mutation", async kind => {
  const f = await httpFixture(), run = prepare(f.input);
  const killed = await advanceProcess(run.referenceFile, { sessionRoot: f.sessionRoot, kind }).result;
  expect(killed.code).toBeNull();
  expect(f.commands).toHaveLength(kind === "workflow_operation" ? 0 : 1);
  const resumed = await advanceProcess(run.referenceFile).result;
  expect(resumed.code).toBe(0); expect(JSON.parse(resumed.stdout).result).toMatchObject({ kind: "awaiting_human", step: "understanding_review" });
  expect(f.commands).toHaveLength(7);
  const ids = z.array(z.object({ commandId: z.string() })).parse(f.commands).map(item => item.commandId);
  expect(new Set(ids).size).toBe(7);
}, 30000);
it("holds a concurrent CLI and never repeats a POST whose response was lost by process death", async () => {
  let signalPost: () => void = () => {}, releasePost: () => void = () => {};
  const posted = new Promise<void>(resolve => { signalPost = resolve; });
  const release = new Promise<void>(resolve => { releasePost = resolve; });
  const f = await httpFixture(false, async () => { signalPost(); await release; });
  const run = prepare(f.input), first = advanceProcess(run.referenceFile);
  try {
    await Promise.race([posted, first.result.then(result => { throw new Error(`CLI exited before POST: ${result.stdout} ${result.stderr}`); }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("POST timeout")), 8000))]);
    const concurrent = await advanceProcess(run.referenceFile).result;
    expect(concurrent.code).toBe(2); expect(JSON.parse(concurrent.stdout).result).toMatchObject({ kind: "held", reason: "WORKFLOW_OWNER_LIVE" });
    expect(f.commands).toHaveLength(1);
    first.child.kill("SIGKILL"); await first.result; releasePost();
    const restarted = await advanceProcess(run.referenceFile).result;
    expect(restarted.code).toBe(2); expect(JSON.parse(restarted.stdout).result).toMatchObject({ kind: "held", reason: "WORKFLOW_OUTCOME_UNKNOWN" });
    expect(f.commands).toHaveLength(1);
    expect(await advance(run)).toMatchObject({ kind: "held", reason: "WORKFLOW_OUTCOME_UNKNOWN" });
    expect(audit(run)).toMatchObject({ execution: "held", semantic: "not_evaluated", userTask: "not_observed" });
  } finally { releasePost(); first.child.kill("SIGKILL"); await first.result; }
}, 20000);
function decision(view: z.infer<typeof humanViewSchema>, response: unknown) {
  return { decisionId: randomUUID(), actor: "Synthetic harness operator, not a real R1 participant", at: new Date().toISOString(), checkpointHash: view.checkpointHash, capability: view.capability, assistance: { kind: "none" }, response };
}
it("a persisted human decision requires explicit resumption after process death", async () => {
  const f = await httpFixture(), run = prepare(f.input), view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: decision(view, { kind: "not_needed", activity: "clarification", reason: "No further information in this synthetic control" }) });
  const acceptView = humanViewSchema.parse(await advance(run));
  const accept = decision(acceptView, { kind: "accept_understanding", versionKey: acceptView.workspace.currentVersionId });
  const file = join(f.root, "decision.json"); writeFileSync(file, JSON.stringify(accept));
  const args = ["record-decision", "--run", run.referenceFile, "--file", file];
  const killed = await advanceProcess(run.referenceFile, { sessionRoot: f.sessionRoot, kind: "workflow_decision" }, args).result;
  expect(killed.code).toBeNull(); expect(f.commands).toHaveLength(7);
  expect(await advance(run)).toMatchObject({ kind: "resume_decision", decisionId: accept.decisionId });
  expect(f.commands).toHaveLength(7);
  const resumed = await advanceProcess(run.referenceFile, undefined, args).result;
  expect(resumed.code).toBe(0); expect(JSON.parse(resumed.stdout).result).toMatchObject({ kind: "decision_completed", nextStep: "positioning" });
  expect(f.commands).toHaveLength(8);
  expect(await recordDecision({ run, decision: accept })).toMatchObject({ kind: "decision_completed" }); expect(f.commands).toHaveLength(8);
}, 30000);
it("records a genuine not-needed decision without faking Clarify, then requires a separate exact-version Accept", async () => {
  const f = await httpFixture(), run = prepare(f.input), view = humanViewSchema.parse(await advance(run));
  const skip = decision(view, { kind: "not_needed", activity: "clarification", reason: "Synthetic control has no additional real information; not a Clarify coverage pass." });
  expect(await recordDecision({ run, decision: skip })).toMatchObject({ kind: "decision_completed", nextStep: "understanding_accept" });
  expect(audit(run).uncovered).toMatchObject([{ activity: "clarification", status: "not_covered", decisionId: skip.decisionId }]);
  expect(f.commands).toHaveLength(7);
  expect(await recordDecision({ run, decision: skip })).toMatchObject({ kind: "decision_completed" });
  await expect(recordDecision({ run, decision: { ...skip, actor: "Changed actor" } })).rejects.toThrow("WORKFLOW_DECISION_ID_CONFLICT");
  const acceptView = humanViewSchema.parse(await advance(run)); expect(acceptView.step).toBe("understanding_accept");
  expect(acceptView.workspace.project.phase).toBe("review_required");
  await expect(recordDecision({ run, decision: { ...skip, decisionId: randomUUID() } })).rejects.toThrow("WORKFLOW_STALE_OR_DISALLOWED_DECISION"); expect(f.commands).toHaveLength(7);
  const invalid = decision(acceptView, { kind: "accept_understanding", versionKey: "wrong-version" });
  await expect(recordDecision({ run, decision: invalid })).rejects.toThrow("WORKFLOW_DECISION_TARGET_MISMATCH"); expect(f.commands).toHaveLength(7);
  const accept = decision(acceptView, { kind: "accept_understanding", versionKey: acceptView.workspace.currentVersionId });
  expect(await recordDecision({ run, decision: accept })).toMatchObject({ kind: "decision_completed", nextStep: "positioning" });
  expect(f.commands).toHaveLength(8); expect(z.object({ action: z.literal("accept") }).parse(f.commands[7]).action).toBe("accept");
  expect(await recordDecision({ run, decision: accept })).toMatchObject({ kind: "decision_completed" }); expect(f.commands).toHaveLength(8);
}, 30000);

it("uses the actual Clarify output for explicit Apply and stops before a separate Accept", async () => {
  const f = await httpFixture(), run = prepare(f.input), view = humanViewSchema.parse(await advance(run));
  const question = view.choices[0]; if (!question) throw new Error("Missing actual question");
  const answer = decision(view, { kind: "answer_clarification", taskKey: question.key, originalWords: "Synthetic consultant input: the discussion should seek a limited pilot, not an annual procurement commitment." });
  expect(await recordDecision({ run, decision: answer })).toMatchObject({ kind: "decision_completed", nextStep: "clarification_wait" });
  let candidate: unknown;
  for (let index = 0; index < 10; index++) {
    candidate = await advance(run);
    if (z.object({ kind: z.literal("awaiting_human") }).safeParse(candidate).success) break;
    expect(candidate).toMatchObject({ kind: "awaiting_product" }); await new Promise(done => setTimeout(done, 20));
  }
  const proposal = humanViewSchema.parse(candidate); expect(proposal.step).toBe("clarification_wait");
  expect(proposal.workspace.currentVersionId).toBe(view.workspace.currentVersionId);
  const task = proposal.choices[0]; if (!task) throw new Error("Missing actual Clarify candidate");
  const apply = decision(proposal, { kind: "apply_clarification", candidateKey: task.key });
  expect(await recordDecision({ run, decision: apply })).toMatchObject({ kind: "decision_completed", nextStep: "understanding_accept" });
  const after = humanViewSchema.parse(await advance(run));
  expect(after.step).toBe("understanding_accept"); expect(after.workspace.project.phase).toBe("review_required");
  expect(after.workspace.currentVersionId).not.toBe(view.workspace.currentVersionId);
  expect(z.array(z.object({ action: z.string() })).parse(f.commands).map(item => item.action)).not.toContain("accept");
  const count = f.commands.length;
  expect(await recordDecision({ run, decision: apply })).toMatchObject({ kind: "decision_completed" }); expect(f.commands).toHaveLength(count);
}, 45000);

it("retains a stale Clarify rejection as replayable evidence and holds without Apply", async () => {
  const f = await httpFixture(), run = prepare(f.input), initial = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: decision(initial, { kind: "answer_clarification", taskKey: initial.choices[0]?.key, originalWords: "Synthetic consultant input: the discussion should seek a limited pilot, not an annual procurement commitment." }) });
  let result: unknown;
  for (let index = 0; index < 10; index++) {
    result = await advance(run);
    if (z.object({ kind: z.literal("awaiting_human") }).safeParse(result).success) break;
    expect(result).toMatchObject({ kind: "awaiting_product" }); await new Promise(done => setTimeout(done, 20));
  }
  const candidate = humanViewSchema.parse(result); expect(candidate.step).toBe("clarification_wait");
  const choice = candidate.choices[0]; if (!choice) throw new Error("Missing actual Clarify candidate");
  expect(candidate.workspace.clarifications?.find(item => item.id === choice.key)?.status).toBe("proposal_ready");
  const stale = decision(candidate, { kind: "apply_clarification", candidateKey: choice.key });
  addFixtureMaterial({ name: "external.md", mediaType: "text/markdown", text: "Synthetic external material changes the displayed Clarify inputs." });
  const beforeDecision = readFixtureState();
  const count = f.commands.length;
  await expect(recordDecision({ run, decision: stale })).rejects.toThrow("WORKFLOW_STALE_DECISION");
  expect(f.commands).toHaveLength(count); expect(readFixtureState()).toEqual(beforeDecision);
  expect(audit(run).integrity).toBe("valid");
  expect(await advance(run)).toMatchObject({ kind: "held", reason: "WORKFLOW_CLARIFICATION_BASE_CHANGED" });
  expect(report(run)).toMatchObject({ integrity: "valid", execution: "held", semantic: "not_evaluated", userTask: "not_observed" });
  const locator = JSON.parse(readFileSync(run.referenceFile, "utf8"));
  const state = verifyTaskSession(loadEvidencePolicy(locator.policyInput), locator.initialReference);
  expect(state.observations.some(item => z.object({ kind: z.literal("workflow_decision_rejected"), reason: z.literal("WORKFLOW_PRODUCT_CHANGED") }).safeParse(item.data).success)).toBe(true);
  await expect(recordDecision({ run, decision: stale })).rejects.toThrow("WORKFLOW_DECISION_REJECTED");
  expect(await advance(run)).toMatchObject({ kind: "held", reason: "WORKFLOW_CLARIFICATION_BASE_CHANGED" }); expect(f.commands).toHaveLength(count);
}, 45000);

it("a changed product makes the displayed checkpoint stale and cannot execute its decision", async () => {
  const f = await httpFixture(), run = prepare(f.input), view = humanViewSchema.parse(await advance(run));
  const binding = JSON.parse(readFileSync(f.input.launchReceiptFile, "utf8"));
  const external = await fetch(`${binding.baseURL}api/workspace`, { method: "POST", headers: { "content-type": "application/json", "x-pitchroom-eval-instance": binding.instance.instanceId, "x-pitchroom-eval-source": binding.instance.sourceFingerprint, "x-pitchroom-eval-target": binding.instance.targetFingerprint }, body: JSON.stringify({ action: "add_material", commandId: "synthetic-external-change", name: "extra.md", mediaType: "text/markdown", text: "New synthetic material outside this workflow intent." }) });
  expect(external.status).toBe(200); const count = f.commands.length;
  const stale = decision(view, { kind: "not_needed", activity: "clarification", reason: "This no longer refers to the current input." });
  await expect(recordDecision({ run, decision: stale })).rejects.toThrow("WORKFLOW_STALE_DECISION");
  expect(f.commands).toHaveLength(count);
  await expect(recordDecision({ run, decision: stale })).rejects.toThrow("WORKFLOW_DECISION_REJECTED"); expect(f.commands).toHaveLength(count);
}, 30000);

it.each([false, true])("committed snapshots cannot bypass empty initialization (earlier empty snapshot: %s)", async earlierEmpty => {
  const f = await httpFixture();
  const empty = workspaceStateSchema.parse(JSON.parse(JSON.stringify(readFixtureState())));
  const existing = workspaceStateSchema.parse(JSON.parse(JSON.stringify(addFixtureMaterial({ name: "preexisting.md", mediaType: "text/markdown", text: "Preexisting synthetic material outside this task run." }))));
  const control = prepare(f.input);
  expect(await advance(control)).toMatchObject({ kind: "held", reason: "WORKFLOW_REQUIRES_EMPTY_OWNED_PROJECT" }); expect(f.commands).toHaveLength(0);
  const run = prepare({ ...f.input, sessionId: randomUUID() });
  const locator = JSON.parse(readFileSync(run.referenceFile, "utf8")), policy = loadEvidencePolicy(locator.policyInput);
  const state = verifyTaskSession(policy, locator.initialReference), at = new Date().toISOString();
  const input = {
    stage: "materials", attemptId: "synthetic-imported-initial", commandId: "synthetic-read", projectId: existing.project.id, revision: existing.project.revision,
    startedAt: at, endedAt: at, parentCheckpointHashes: [], versionIds: { understanding: null, positioning: null, story: null, deck: null },
    model: "not_applicable_http_readback", promptVersion: "synthetic", runtime: state.manifest.identity.runtime,
    usage: { kind: "unknown", reason: "Synthetic no-provider control" }, request: { kind: "synthetic_read" },
    response: { kind: "transport_summary", status: "received", httpStatus: 200, providerStatus: null, observedModel: null },
    originalBodyDigests: { request: { kind: "unknown", reason: "No GET body" }, response: { kind: "known", sha256: hashTaskBytes(JSON.stringify(existing)), scope: "body_bytes_before_projection", evidenceRef: "synthetic fixture read" } },
    result: { kind: "unverified_record", data: { kind: "workflow_workspace", workspace: existing, workspaceHash: hashTaskValue(existing) } },
  };
  let reference = state.reference;
  if (earlierEmpty) {
    const savedEmpty = appendTaskCheckpoint(policy, reference, { ...input, attemptId: "synthetic-earlier-empty", revision: empty.project.revision, result: { kind: "unverified_record", data: { kind: "workflow_workspace", workspace: empty, workspaceHash: hashTaskValue(empty) } } });
    reference = appendTaskObservation(policy, savedEmpty.reference, { id: "synthetic-earlier-snapshot", at, stage: "materials", attemptId: null, commandId: null, checkpointHash: null, kind: "observation", data: { kind: "workflow_snapshot", checkpointHash: savedEmpty.checkpointHash } });
  }
  const saved = appendTaskCheckpoint(policy, reference, input);
  appendTaskObservation(policy, saved.reference, { id: "synthetic-imported-snapshot", at, stage: "materials", attemptId: null, commandId: null, checkpointHash: null, kind: "observation", data: { kind: "workflow_snapshot", checkpointHash: saved.checkpointHash } });
  const reason = earlierEmpty ? "WORKFLOW_UNEXPLAINED_SNAPSHOT_CHANGE" : "WORKFLOW_INITIAL_SNAPSHOT_NOT_EMPTY";
  expect(() => audit(run)).toThrow(reason);
  await expect(advance(run)).rejects.toThrow(reason); expect(f.commands).toHaveLength(0);
}, 30000);

it("a forged resolved-stage event cannot bypass the human action's permitted transition", async () => {
  const f = await httpFixture(), run = prepare(f.input), view = humanViewSchema.parse(await advance(run));
  const chosen = decision(view, { kind: "not_needed", activity: "clarification", reason: "Synthetic no-question case." });
  const locator = JSON.parse(readFileSync(run.referenceFile, "utf8")), policy = loadEvidencePolicy(locator.policyInput);
  let reference = verifyTaskSession(policy, locator.initialReference).reference;
  reference = appendTaskObservation(policy, reference, { id: `workflow:decision:${chosen.decisionId}`, at: new Date().toISOString(), stage: "understanding", attemptId: null, commandId: null, checkpointHash: null, kind: "observation", data: { kind: "workflow_decision", decision: chosen } });
  appendTaskObservation(policy, reference, { id: `workflow:decision-done:${chosen.decisionId}`, at: new Date().toISOString(), stage: "actual_use", attemptId: null, commandId: null, checkpointHash: null, kind: "observation", data: { kind: "workflow_decision_resolved", decisionId: chosen.decisionId, nextStep: "finished" } });
  expect(() => audit(run)).toThrow("WORKFLOW_DECISION_RESOLUTION_EFFECT_MISMATCH"); expect(f.commands).toHaveLength(7);
}, 30000);

it("keeping the first Story without adopting it cannot create a Deck or invent feedback", async () => {
  const f = await httpFixture(true), run = prepare(f.input);
  let view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: decision(view, { kind: "not_needed", activity: "clarification", reason: "Synthetic uncovered branch" }) });
  view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: decision(view, { kind: "accept_understanding", versionKey: view.workspace.currentVersionId }) });
  view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: decision(view, { kind: "choose_positioning", choiceKey: view.choices[0]?.key }) });
  view = humanViewSchema.parse(await advance(run));
  const rejected = view.choices[0]?.key;
  await recordDecision({ run, decision: decision(view, { kind: "keep_story", candidateKey: rejected }) });
  view = humanViewSchema.parse(await advance(run));
  expect(view.step).toBe("feedback"); expect(view.workspace.story?.head.storyId).toBeNull(); expect(view.workspace.deck).toBeUndefined();
  expect(view.workspace.story?.proposals.some(item => item.id === rejected)).toBe(true);
  const count = f.commands.length;
  await expect(recordDecision({ run, decision: decision(view, { kind: "not_needed", activity: "story_revision", reason: "Cannot skip feedback without an adopted draft" }) })).rejects.toThrow("WORKFLOW_STALE_OR_DISALLOWED_DECISION");
  expect(f.commands).toHaveLength(count);
  expect(await advance(run)).toMatchObject({ kind: "awaiting_human", step: "feedback" }); expect(f.commands).toHaveLength(count);
}, 30000);

it.each([false, true])("carries positioning, Story feedback/Keep, Undo/restore and exact edits into Deck V2 (use record: %s)", async recordUse => {
  const f = await httpFixture(true), run = prepare(f.input);
  let view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: decision(view, { kind: "not_needed", activity: "clarification", reason: "This engineering control exercises the separately labelled uncovered branch." }) });
  view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: decision(view, { kind: "accept_understanding", versionKey: view.workspace.currentVersionId }) });
  view = humanViewSchema.parse(await advance(run)); expect(view.step).toBe("positioning_choice");
  const positioning = view.workspace.positioning; if (!positioning) throw new Error("Missing actual positioning");
  expect(readPositioning(positioning).applied).toBeNull();
  const original = JSON.parse(readFileSync(join(f.input.caseDirectory, "case.json"), "utf8")).spec.originalFraming;
  const retained = positioning.proposal.retainedChoices?.find(choice => choice.kind === "manual_exact" && choice.text === original);
  if (!retained) throw new Error("Frozen case wording was not preserved as an attributed candidate");
  await recordDecision({ run, decision: decision(view, { kind: "choose_positioning", choiceKey: retained.id }) });
  view = humanViewSchema.parse(await advance(run)); expect(view.step).toBe("story_initial_candidate");
  expect(view.workspace.story?.head.storyId).toBeNull();
  await recordDecision({ run, decision: decision(view, { kind: "apply_story", candidateKey: view.choices[0]?.key }) });
  view = humanViewSchema.parse(await advance(run)); expect(view.step).toBe("feedback");
  const initialId = view.workspace.story?.head.storyId; if (!initialId) throw new Error("Missing actually adopted initial Story");
  const feedback = { kind: "feedback", storyKey: initialId, observedCheckpointHash: view.checkpointHash, originalWords: "Put the limited pilot decision ahead of the feature list and keep the unknowns explicit.", mustChange: ["PRIVATE-MUST-CHANGE-CONTROL"], mustPreserve: ["PRIVATE-MUST-PRESERVE-CONTROL"], mustNot: ["PRIVATE-MUST-NOT-CONTROL"] };
  const count = f.commands.length; await recordDecision({ run, decision: decision(view, feedback) }); expect(f.commands).toHaveLength(count);
  view = humanViewSchema.parse(await advance(run)); expect(view.step).toBe("story_revision_candidate");
  expect(view.workspace.story?.head.storyId).toBe(initialId);
  const revisions = f.commands.filter(command => z.object({ action: z.literal("propose_story"), request: z.object({ kind: z.literal("revise_story") }) }).safeParse(command).success);
  expect(revisions).toHaveLength(1);
  expect(z.object({ request: z.object({ judgment: z.string() }) }).parse(revisions[0]).request.judgment).toBe(feedback.originalWords);
  expect(JSON.stringify(f.commands)).not.toContain("PRIVATE-MUST-");
  await recordDecision({ run, decision: decision(view, { kind: "keep_story", candidateKey: view.choices[0]?.key }) });
  view = humanViewSchema.parse(await advance(run)); expect(view.step).toBe("deck_review");
  const firstDeck = view.workspace.deck; if (!firstDeck || firstDeck.proposal.schemaVersion !== 2) throw new Error("Missing adopted Story Deck V2");
  expect(firstDeck.proposal.storyVersionId).toBe(initialId);
  await recordDecision({ run, decision: decision(view, { kind: "undo_story" }) });
  view = humanViewSchema.parse(await advance(run)); expect(view.workspace.story?.head.storyId).toBeNull();
  await recordDecision({ run, decision: decision(view, { kind: "restore_story", storyKey: initialId }) });
  view = humanViewSchema.parse(await advance(run)); expect(view.step).toBe("story_initial_candidate");
  await recordDecision({ run, decision: decision(view, { kind: "apply_story", candidateKey: view.choices[0]?.key }) });
  view = humanViewSchema.parse(await advance(run));
  const restored = view.workspace.story?.versions.find(item => item.id === view.workspace.story?.head.storyId);
  if (!restored) throw new Error("Missing restored/adopted Story");
  const exact = { ...feedback, kind: "exact_edit_story", storyKey: restored.id, observedCheckpointHash: view.checkpointHash, originalWords: "Use the following exact opening as a synthetic manual correction.", blockKey: restored.story.blocks[0]?.id, title: "Discuss a limited pilot first", body: "Synthetic exact edit for discussion; outcomes remain unverified." };
  await recordDecision({ run, decision: decision(view, exact) });
  view = humanViewSchema.parse(await advance(run)); expect(view.step).toBe("story_revision_candidate");
  await recordDecision({ run, decision: decision(view, { kind: "apply_story", candidateKey: view.choices[0]?.key }) });
  view = humanViewSchema.parse(await advance(run)); expect(view.step).toBe("deck_review");
  const story = view.workspace.story?.versions.find(item => item.id === view.workspace.story?.head.storyId), deck = view.workspace.deck;
  if (!story || !deck || !view.workspace.story) throw new Error("Missing actual Story/Deck");
  expect(deck.proposal).toEqual(storyToDeck({ storyId: story.id, generation: view.workspace.story.head.generation, story: story.story }));
  expect(deck.proposal.pages[0]).toMatchObject({ title: exact.title, body: exact.body });
  expect(view.workspace.deckVersions.some(item => item.id === firstDeck.id && hashTaskValue(item.proposal) === hashTaskValue(firstDeck.proposal))).toBe(true);
  await recordDecision({ run, decision: decision(view, { kind: "edit_deck_page", pageKey: deck.proposal.pages[0]?.id, title: "Synthetic discussion draft", body: "Manual page wording remains unreviewed by the earlier evidence." }) });
  view = humanViewSchema.parse(await advance(run));
  expect(view.workspace.deck?.proposal.pages[0]?.title).toBe("Synthetic discussion draft");
  expect(view.workspace.deckVersions.some(item => item.id === deck.id && hashTaskValue(item.proposal) === hashTaskValue(deck.proposal))).toBe(true);
  await recordDecision({ run, decision: decision(view, { kind: "record_review", originalWords: "Synthetic operator reviewed the edited draft; no real downstream use occurred." }) });
  view = humanViewSchema.parse(await advance(run)); expect(view.step).toBe("actual_use");
  const use = decision(view, recordUse
    ? { kind: "record_use", scope: "assisted_self_test", activity: "Synthetic observation record for projection testing; no actual participant", evidenceRefs: ["synthetic-local-observation"], edits: [], activeReviewSeconds: 2, waitingSeconds: 1 }
    : { kind: "use_not_observed", reason: "Engineering test only; no actual user discussion." });
  await recordDecision({ run, decision: use });
  expect(await advance(run)).toMatchObject({ kind: "finished" });
  expect(audit(run)).toMatchObject({ execution: "finished", semantic: "not_evaluated", userTask: recordUse ? "recorded_awaiting_review" : "not_observed", useRecordDecisionIds: recordUse ? [use.decisionId] : [] });
  expect(JSON.stringify(f.commands)).not.toContain("PRIVATE-MUST-");
}, 120000);
