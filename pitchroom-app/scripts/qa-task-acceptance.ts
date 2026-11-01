import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "../packages/evals/node_modules/zod/index.js";
import { workspaceStateSchema, workspaceCommandSchema, evaluationInstanceSchema } from "../packages/domain/src/index";
import { freezeTaskBundle, hashTaskBytes, hashTaskValue, parseTaskBundle, taskRubric, type TaskBundle } from "../packages/evals/src/task-acceptance/schema";
import { advance, audit, installSyntheticProviderCollector, prepare, readWorkflowReviewContext, recordDecision, taskAcceptanceSourcePaths } from "../packages/evals/src/task-acceptance/workflow";
import { calibrationBank, issueReviewPacket, recordReviewEvidence, targetAt, type ProviderCapture, type ReviewPacket, type ReviewRecord } from "../packages/evals/src/task-acceptance/review";
import { assessTask } from "../packages/evals/src/task-acceptance/verdict";
import { checkProviderCapture, compareAdoptedDeck, providerCaptureHeader } from "../packages/evals/src/task-acceptance/checks";
import { assertUnlinkedPath, loadEvidencePolicy, reserveEvidenceWrite } from "../packages/evals/src/task-acceptance/capacity";
import { verifyTaskSession } from "../packages/evals/src/task-acceptance/session";
import { IsolatedWorkspaceClient, parseWorkspaceBinding } from "../packages/evals/src/task-acceptance/workspace-client";
import { ResponsesPositioningRunner, budgetedProviderFetch, initializeProviderBudget, inspectProviderBudget, providerBudgetPolicySchema } from "../packages/agent/src/index";
import { chromium } from "../apps/web/e2e/provider-budget-browser";

export const qualificationCapacity = Object.freeze({
  standaloneBytes: 25_000_000,
  standaloneWorkflowBytes: 24_000_000,
  offlineReportBytes: 1_000_000,
  roleCount: 3,
  operatorReserveBytes: 2_000_000,
  proposedAdditionalBytes: 80_000_000,
});
export const privateOracleMarker = "PIT56_PRIVATE_ORACLE_CONTROL";
export const privateFeedbackMarker = "PIT56_PRIVATE_FEEDBACK_CONTROL";
const timestamp = "2026-11-01T00:00:00Z";
const self = fileURLToPath(import.meta.url), app = resolve(dirname(self), ".."), repository = dirname(app);
const guardReadySchema = z.object({ pid: z.number().int().positive(), nonce: z.string().uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), origin: z.string().url(), canaryHash: z.string().regex(/^[a-f0-9]{64}$/), externalDispatches: z.literal(0) }).strict();
const guardAttemptSchema = z.object({ pid: z.number().int().positive(), sequence: z.number().int().nonnegative(), nonce: z.string().uuid(), canary: z.boolean(), origin: z.string().url(), blockedBeforeNetwork: z.literal(true), previous: z.string().regex(/^[a-f0-9]{64}$/), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Run = ReturnType<typeof prepare>;
export const qualificationView = z.object({ kind: z.literal("awaiting_human"), step: z.string(), checkpointHash: z.string(), capability: z.string(), workspace: workspaceStateSchema, choices: z.array(z.object({ key: z.string() })) });
export type QualificationView = z.infer<typeof qualificationView>;
export function qualificationDecision(view: QualificationView, response: unknown) {
  return { decisionId: randomUUID(), actor: "scripted-PIT56-operator", at: timestamp, checkpointHash: view.checkpointHash, capability: view.capability, assistance: { kind: "none" }, response };
}

/** New, explicitly synthetic material; never refreezes or edits R1. */
export function writeQualificationCase(directory: string): TaskBundle {
  assert(!existsSync(directory)); mkdirSync(directory, { mode: 0o700 });
  const source = { id: "pilot", authority: "Synthetic qualification fixture", url: "https://example.invalid/pit56", material: "A two-week pilot is proposed. Approval and revenue results are unknown.", boundary: "A proposal is not an achieved result." };
  const fixture = { id: "pit56-synthetic-v1", evaluationProfile: "generic_core_message", originalFraming: "Discuss a limited pilot.", sources: [source] };
  const materialPackageText = JSON.stringify(fixture);
  const stages = ["materials", "understanding", "clarify", "positioning", "story_initial", "story_revision", "deck", "actual_use"];
  const origin = { kind: "explicit_user_statement", evidenceRef: "synthetic-control-not-human-consent" };
  const spec = { caseId: fixture.id, caseVersion: "1", caseKind: "synthetic", materialPackage: { path: "materials.json", sha256: hashTaskBytes(materialPackageText), fixtureId: fixture.id },
    materials: [{ sourceId: source.id, packagePointer: "/sources/0", sourceVersion: "1", sourceSha256: hashTaskValue(source), sourceDate: { kind: "unknown", reason: "Synthetic control." }, permission: { kind: "local_evaluation_only", evidenceRef: "PIT56-synthetic-source", externalTransfer: "not_authorized" } }],
    audience: { value: "Pilot decision owner", origin }, decisionGoal: { value: "Decide whether to discuss the proposed pilot", origin }, useContext: { value: "Synthetic tool qualification only", origin },
    originalFraming: fixture.originalFraming, outputLanguage: "en", requiredStages: stages, rubricVersion: taskRubric.version,
    feedbackPolicy: { kind: "after_actual_output", requirements: ["Preserve approval uncertainty."] }, participantMode: "scripted_synthetic" };
  const oracle = { caseId: fixture.id, caseVersion: "1", oracleVersion: "1", rubricVersion: taskRubric.version, items: [
    { id: "unknown", kind: "must_preserve", meaning: "Approval is unknown.", sourceRefs: [{ sourceId: source.id, quote: "Approval and revenue results are unknown." }], applicableStages: stages, severity: "critical", rationale: privateOracleMarker },
    { id: "goal", kind: "forbidden_upgrade", meaning: "Do not call the proposed pilot an achieved result.", sourceRefs: [{ sourceId: source.id, quote: "A two-week pilot is proposed." }], applicableStages: stages, severity: "critical", rationale: privateOracleMarker },
  ] };
  const draft = { schemaVersion: 1, status: "draft", spec, openDecisions: [{ id: "synthetic-freeze", question: "Qualification only?", recommendation: "Yes; never real R1." }] };
  const parsed = parseTaskBundle({ taskCase: draft, oracle, materialPackageText });
  const frozen = freezeTaskBundle({ bundle: parsed, binding: parsed.binding, confirmation: { actor: "scripted-fixture", role: "material_owner_and_product_owner", confirmedAt: timestamp, evidenceRef: "synthetic-fixture-confirmation-not-real-consent" } });
  writeFileSync(join(directory, "case.json"), JSON.stringify(frozen), { flag: "wx", mode: 0o600 });
  writeFileSync(join(directory, "oracle.json"), JSON.stringify(oracle), { flag: "wx", mode: 0o600 });
  writeFileSync(join(directory, "materials.json"), materialPackageText, { flag: "wx", mode: 0o600 });
  return parseTaskBundle({ taskCase: frozen, oracle, materialPackageText });
}

export function qualificationReviewer(run: Run) {
  const authority: Extract<ReviewRecord, { kind: "review_authority" }> = { kind: "review_authority", id: "synthetic-authority", at: timestamp, operatorEvidenceRef: "scripted-negative-controls-not-human-acceptance", mode: "scripted_synthetic",
    actors: [{ actorId: "scripted-reviewer", personId: "scripted-person", role: "human", permissions: ["review", "material_owner", "adjudicate", "capture_provider"] }] };
  recordReviewEvidence(run, authority);
  const calibration: Extract<ReviewRecord, { kind: "review_calibration" }> = { kind: "review_calibration", id: "synthetic-calibration", at: timestamp, actorId: "scripted-reviewer", authorityHash: hashTaskValue(authority), bankHash: hashTaskValue(calibrationBank),
    answers: calibrationBank.map(item => ({ caseId: item.id, supportVerdict: item.expected, reason: "Known synthetic control, not semantic calibration of a real person." })) };
  recordReviewEvidence(run, calibration);
  return { authority, calibration };
}
export function qualificationPacket(run: Run, checkpointHash: string, reviewer: ReturnType<typeof qualificationReviewer>): ReviewPacket {
  const template = issueReviewPacket(run, { checkpointHash, actorId: reviewer.calibration.actorId });
  const dimensions: readonly string[] = template.stage === "positioning" ? taskRubric.positioning.dimensions : ["story_initial", "story_revision", "deck"].includes(template.stage) ? taskRubric.storyDeck.dimensions : [];
  const pointer = template.fields[0]?.pointer; assert(pointer, "Actual output has no reviewable fields");
  return { kind: "review_packet", id: randomUUID(), at: timestamp, actorId: reviewer.calibration.actorId, authorityHash: template.authorityHash, calibrationHash: hashTaskValue(reviewer.calibration), binding: template.binding,
    fields: template.fields.filter(field => field.classification === "prose").map(field => ({ kind: "no_factual_claim", pointer: field.pointer, valueHash: field.valueHash, readWholeField: true, reason: "Scripted acceptance-tool control; this disposition does not certify model semantics." })),
    oracle: template.oracle.map(item => ({ oracleId: item.id, verdict: "preserved", fieldPointers: [pointer], reason: "Scripted positive control." })),
    scores: dimensions.map(dimension => ({ dimension, score: 3, reason: "Fixed synthetic score; no human rating claimed." })), directionDifference: "Synthetic comparison, not a model-quality judgment.", assistance: ["All review answers are scripted controls."] };
}

/** The citation is genuine; the deliberately adverse judgment is a scripted tool control. */
export function qualificationGoalUpgrade(run: Run, packet: ReviewPacket): ReviewPacket {
  const template = issueReviewPacket(run, { checkpointHash: packet.binding.checkpointHash, actorId: packet.actorId });
  const field = template.fields.find(item => item.classification === "prose" && typeof item.value === "string" && item.value.length > 0);
  assert(field && typeof field.value === "string", "Missing actual generated text field");
  const fieldText = field.value, source = readWorkflowReviewContext(run).bundle.fixture.sources[0];
  assert(source, "Missing actual synthetic material");
  const preserved = { preserved: true, reason: "Scripted positive control." };
  return { ...packet, fields: packet.fields.map(item => item.pointer !== field.pointer ? item : {
    kind: "claims", pointer: field.pointer, valueHash: field.valueHash, readWholeField: true, allKeyClaimsExtracted: true,
    claims: [{ claimId: "goal-as-achievement", checkpointHash: packet.binding.checkpointHash, location: { pointer: field.pointer, start: 0, end: fieldText.length }, text: fieldText,
      nature: "fact", evidenceRefs: [{ sourceId: source.id, sourceHash: hashTaskValue(source), quote: source.material, start: 0, end: source.material.length }], supportVerdict: "insufficient_support",
      conditions: preserved, time: preserved, attribution: preserved, certainty: { preserved: false, reason: "Scripted adverse judgment: the source establishes a proposal, never an achieved result." },
      severity: "critical", reviewer: packet.actorId, reason: "Qualification of the adjudication tool, not a finding about live model output." }],
  }) };
}

function byteCount(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    assert(!entry.isSymbolicLink(), "Evidence symlink refused");
    const child = join(path, entry.name); return sum + (entry.isDirectory() ? byteCount(child) : statSync(child).size);
  }, 0);
}
const capacityApprovalSha256 = "8ca6d7aeb715a52a85658d17492d4d9ad6831045ebdc2d2c95c67a95cfd1d585";
const allocationSchema = z.object({ issue: z.literal("PIT-56"), head: z.string().regex(/^[a-f0-9]{40}$/), sourceTree: z.string().regex(/^[a-f0-9]{40}$/), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), evidenceDirectory: z.string().refine(isAbsolute), createdAt: z.string().datetime({ offset: true }),
  globalCapBytes: z.literal(400_000_000), countedHighWaterBytes: z.number().int().nonnegative(), allocatedBytes: z.literal(25_000_000), concurrentReservedBytes: z.number().int().nonnegative(), authority: z.string().min(1),
  approvalFile: z.string().refine(isAbsolute), capacityReceiptFile: z.string().refine(isAbsolute), capacityReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function until<T>(action: () => Promise<T>, ready: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (true) { const value = await action(); if (ready(value)) return value; assert(Date.now() < end, "Bounded readiness deadline exceeded"); await delay(100); }
}
async function availablePort() {
  const server = createServer(); await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert(address && typeof address !== "string");
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); return address.port;
}

type ChildHandle = { instance: ChildProcess; exited: Promise<number | null>; kill: () => void };
type PersistentInputs = {
  evidence: string; head: string; sourceHash: string; source: { path: string; sha256: string }[]; container: string; databaseName: string;
  docker: (args: string[]) => string;
  child: (name: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs?: number) => ChildHandle;
  stop: (running: ChildHandle) => Promise<void>;
  write: (name: string, value: unknown) => void;
  checked: (id: string, expected: unknown, actual: unknown) => void;
  refused: (id: string, pattern: RegExp, action: () => unknown | Promise<unknown>) => Promise<void>;
  markContainerStarted: () => void;
};
async function qualifyPersistentWorkflow(input: PersistentInputs) {
  const { evidence, sourceHash, docker, child, stop, write, checked, refused } = input;
  const approvedImage = "sha256:25a89970a83255ae96484d709005bb35aa71f7455f941bc1634514f31c5d5c62";
  checked("existing-approved-postgres-image", approvedImage, docker(["image", "inspect", "--format", "{{.Id}}", "postgres:17-alpine"]));
  assert.equal(docker(["ps", "--all", "--filter", `name=^/${input.container}$`, "--format", "{{.ID}}"]), "", "Owned container name must be fresh");
  input.markContainerStarted();
  docker(["run", "--detach", "--rm", "--pull=never", "--name", input.container, "--label", "pitchroom.qa=pit56-synthetic", "--log-driver", "none", "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=pit56_qa", "--env", "POSTGRES_PASSWORD=test", "--env", `POSTGRES_DB=${input.databaseName}`, approvedImage]);
  const address = docker(["port", input.container, "5432/tcp"]); assert.match(address, /^127\.0\.0\.1:\d+$/);
  await until(async () => { try { return docker(["exec", input.container, "pg_isready", "-h", "127.0.0.1", "-U", "pit56_qa", "-d", input.databaseName]).includes("accepting connections"); } catch { return false; } }, Boolean, 20_000);
  const connectionURL = new URL("postgres://pit56_qa:test@127.0.0.1/");
  connectionURL.port = address.slice("127.0.0.1:".length);
  connectionURL.pathname = `/${input.databaseName}`;
  assert.equal(connectionURL.host, address);
  const databaseURL = connectionURL.toString();
  const { createDatabase, PitchroomRepository } = await import("../packages/persistence/src/index");
  const { migrate } = await import("../packages/persistence/node_modules/drizzle-orm/postgres-js/migrator");
  const database = createDatabase(databaseURL);
  let projectId: string;
  try {
    const name = await database.client`select current_database() as name`;
    assert.equal(name[0]?.name, input.databaseName);
    await migrate(database.db, { migrationsFolder: join(app, "packages/persistence/migrations") });
    const project = await new PitchroomRepository(database.db).ensureProject("atelier", "PIT56 synthetic qualification"); projectId = project.id;
  } finally { await database.client.end(); }
  const origin = `http://127.0.0.1:${await availablePort()}`, instanceId = randomUUID(), guardNonce = randomUUID(), guardDirectory = join(evidence, "child-transport");
  mkdirSync(guardDirectory, { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, DATABASE_URL: databaseURL, PITCHROOM_RUNTIME: "postgres-fake", PITCHROOM_ISOLATED_QA: "1", NEXT_TELEMETRY_DISABLED: "1", PITCHROOM_EVAL_INSTANCE_ID: instanceId, PITCHROOM_EVAL_SOURCE_HASH: sourceHash,
    PIT56_CHILD_NETWORK_GUARD: origin, PIT56_CHILD_GUARD_DIRECTORY: guardDirectory, PIT56_CHILD_GUARD_NONCE: guardNonce, NODE_OPTIONS: `--import=tsx --import=${self}` };
  const readChildAttempts = () => {
    const files = readdirSync(guardDirectory);
    assert(!files.some(file => file.endsWith(".incomplete.json")), "Child transport observation failed; zero calls cannot be certified");
    assert(files.every(file => /^\d+\.(ready\.json|attempts\.jsonl)$/.test(file)));
    assert(files.filter(file => file.endsWith(".attempts.jsonl")).every(file => files.includes(file.replace(".attempts.jsonl", ".ready.json"))), "Child transport startup was incomplete");
    return files.filter(file => file.endsWith(".ready.json")).flatMap(file => {
      const ready = guardReadySchema.parse(JSON.parse(readFileSync(join(guardDirectory, file), "utf8")));
      assert.equal(ready.nonce, guardNonce); assert.equal(ready.sourceHash, sourceHash); assert.equal(ready.origin, origin);
      const attempts = readFileSync(join(guardDirectory, `${ready.pid}.attempts.jsonl`), "utf8").trim().split("\n").map(line => guardAttemptSchema.parse(JSON.parse(line)));
      let previous = hashTaskValue({ pid: ready.pid, nonce: guardNonce, sourceHash, origin });
      attempts.forEach((event, sequence) => {
        const { hash, ...body } = event;
        assert.equal(event.pid, ready.pid); assert.equal(event.nonce, guardNonce); assert.equal(event.sequence, sequence); assert.equal(event.previous, previous);
        assert.equal(hash, hashTaskValue(body)); assert.equal(event.canary, sequence === 0); previous = hash;
      });
      assert.equal(attempts[0]?.origin, "https://pit56.invalid"); assert.equal(attempts[0]?.hash, ready.canaryHash);
      return attempts;
    });
  };
  const nativeFetch = globalThis.fetch;
  const runController = new AbortController();
  const localFetch: typeof fetch = (url, options) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    assert.equal(target.origin, origin, "External network refused during offline qualification");
    const timeout = AbortSignal.timeout(30_000);
    return nativeFetch(url, { ...options, redirect: "error", signal: AbortSignal.any([runController.signal, timeout, ...(options?.signal ? [options.signal] : [])]) });
  };
  const startWeb = async (name: string) => {
    const server = child(name, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", new URL(origin).port], join(app, "apps/web"), environment);
    const health = await until(async () => {
      if (server.instance.exitCode !== null || server.instance.signalCode !== null) throw new Error(`${name}: server exited before readiness (${await server.exited})`);
      try {
        const response = await localFetch(origin + "/api/health", { signal: AbortSignal.timeout(3000) });
        return response.ok ? z.object({ status: z.literal("ready"), runtime: z.literal("postgres-fake"), evaluationInstance: evaluationInstanceSchema }).parse(await response.json()) : null;
      } catch { return null; }
    }, value => value !== null, 90_000);
    assert(health);
    const ready = guardReadySchema.parse(JSON.parse(readFileSync(join(guardDirectory, `${health.evaluationInstance.pid}.ready.json`), "utf8")));
    checked(`${name}-actual-pid-transport-guard`, { pid: health.evaluationInstance.pid, nonce: guardNonce, sourceHash, origin }, { pid: ready.pid, nonce: ready.nonce, sourceHash: ready.sourceHash, origin: ready.origin });
    checked(`${name}-canary-refused-and-recorded`, true, readChildAttempts().some(event => event.pid === ready.pid && event.canary && event.blockedBeforeNetwork));
    write(`${name}-identity.json`, { health, guard: ready }); return { server, identity: health.evaluationInstance };
  };
  let web = await startWeb("web-first");
  const headers = () => ({ "content-type": "application/json", "x-pitchroom-eval-instance": web.identity.instanceId, "x-pitchroom-eval-source": web.identity.sourceFingerprint, "x-pitchroom-eval-target": web.identity.targetFingerprint });
  const readWorkspace = async () => { const response = await localFetch(origin + "/api/workspace", { headers: headers() }); assert.equal(response.status, 200); return workspaceStateSchema.parse(await response.json()); };
  checked("fresh-owned-postgres-project", { id: projectId, phase: "empty" }, ((state) => ({ id: state.project.id, phase: state.project.phase }))(await readWorkspace()));
  const caseDirectory = join(evidence, "case"), bundle = writeQualificationCase(caseDirectory);
  const accounting = join(evidence, "accounting"), accountingPolicyFile = join(evidence, "policy.json"), launchReceiptFile = join(evidence, "launch.json");
  for (const path of ["pitchroom-v6/evidence", "history", "pitchroom-app/.artifacts"]) mkdirSync(join(accounting, path), { recursive: true, mode: 0o700 });
  writeFileSync(join(accounting, "pitchroom-v6/manifest.json"), JSON.stringify({ evidencePolicy: { approvedCapBytes: qualificationCapacity.standaloneWorkflowBytes, accountingPackageRoots: ["evidence"], accountingWorkspaceRoots: [{ path: "history", required: true }] } }), { flag: "wx", mode: 0o600 });
  writeFileSync(accountingPolicyFile, JSON.stringify({ repositoryRoot: accounting, recordDirectory: "pitchroom-app/.artifacts/qualification", referenceLinks: [], legacyWriters: "quiescent" }), { flag: "wx", mode: 0o600 });
  const binding = { baseURL: origin + "/", instance: web.identity, projectId, timeoutMs: 30_000, maximumResponseBytes: 2_000_000 };
  writeFileSync(launchReceiptFile, JSON.stringify(binding), { flag: "wx", mode: 0o600 });
  const run = prepare({ caseDirectory, accountingPolicyFile, launchReceiptFile, sourceRepository: repository, sessionId: randomUUID(), maximumBytes: qualificationCapacity.standaloneWorkflowBytes - 16_384, purpose: "tool_validation" });
  const reviewer = qualificationReviewer(run), commands: { action: string; commandId: string }[] = [];
  const collector = installSyntheticProviderCollector();
  let dropClarificationReply = true, firstMutationResolve: (() => void) | undefined, releaseFirstMutation: (() => void) | undefined;
  let firstAdvance: ReturnType<typeof advance> | undefined;
  const firstMutation = new Promise<void>(done => { firstMutationResolve = done; }), mutationBarrier = new Promise<void>(done => { releaseFirstMutation = done; });
  globalThis.fetch = async (url, options) => {
    const target = new URL(url instanceof Request ? url.url : String(url)); assert.equal(target.origin, origin, "External network refused during offline qualification");
    if (options?.method === "POST") {
      assert.equal(typeof options.body, "string");
      const body = z.object({ action: z.string(), commandId: z.string() }).passthrough().parse(JSON.parse(String(options.body)));
      for (const marker of [privateOracleMarker, privateFeedbackMarker]) assert(!String(options.body).includes(marker), "Private evaluator content reached actual workspace HTTP transport");
      commands.push({ action: body.action, commandId: body.commandId });
      const line = JSON.stringify({ url: target.pathname, body, bodyHash: hashTaskBytes(String(options.body)) }) + "\n";
      assert((existsSync(join(evidence, "http-requests.jsonl")) ? statSync(join(evidence, "http-requests.jsonl")).size : 0) + Buffer.byteLength(line) <= 64_000);
      appendFileSync(join(evidence, "http-requests.jsonl"), line, { mode: 0o600 });
      if (commands.length === 1) { assert(firstMutationResolve); firstMutationResolve(); await mutationBarrier; }
      const beforeAttempts = body.action === "create_story_deck" ? new Set(readChildAttempts().map(event => event.hash)) : null;
      const response = await localFetch(url, options);
      if (beforeAttempts) {
        const observed = readChildAttempts().filter(event => !beforeAttempts.has(event.hash) && !event.canary);
        for (const event of observed) await collector.observeCall(`child-refused-fetch:${event.hash}`, async () => undefined);
        write(`deck-transport-${body.commandId}.json`, { commandId: body.commandId, livePid: web.identity.pid, sourceHash, guardNonce, beforeAttemptHashes: [...beforeAttempts], afterAttempts: readChildAttempts(), observedExternalAttemptHashes: observed.map(event => event.hash), externalDispatches: 0 });
      }
      if (body.action === "submit_clarification" && dropClarificationReply) { dropClarificationReply = false; await response.arrayBuffer(); throw new Error("Synthetic lost response after actual server commit"); }
      return response;
    }
    return localFetch(url, options);
  };
  try {
    const first = advance(run); firstAdvance = first;
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([firstMutation, first.then(() => { throw new Error("First advance ended without the mutation barrier"); }),
        new Promise<never>((_done, reject) => { barrierTimer = setTimeout(() => reject(new Error("First mutation deadline exceeded")), 30_000); })]);
    } finally { clearTimeout(barrierTimer); }
    const concurrent = await advance(run); checked("same-session-concurrent-advance", "held", concurrent.kind);
    assert("reason" in concurrent); checked("live-owner-is-not-taken-over", "WORKFLOW_OWNER_LIVE", concurrent.reason);
    assert(releaseFirstMutation); releaseFirstMutation();
    let view = qualificationView.parse(await first);
    checked("initial-understanding-review-boundary", "understanding_review", view.step);
    checked("one-understanding-dispatch", 1, commands.filter(command => command.action === "run").length);
    const initialAssessment = assessTask(run); assert.equal(initialAssessment.kind, "task_assessment");
    assert(initialAssessment.attemptHistory, "Missing committed-output assessment"); checked("unreviewed-output-pending", "awaiting_review", initialAssessment.attemptHistory.find(item => item.binding.checkpointHash === view.checkpointHash)?.semantic.kind);
    const initialPacket = qualificationPacket(run, view.checkpointHash, reviewer);
    await refused("partial-fields-refused", /REVIEW_FIELD_COVERAGE|REVIEW_EMPTY_FIELDS_REASON_REQUIRED/, () => recordReviewEvidence(run, { ...initialPacket, fields: initialPacket.fields.slice(1) }));
    await refused("partial-oracle-refused", /REVIEW_ORACLE_COVERAGE/, () => recordReviewEvidence(run, { ...initialPacket, oracle: initialPacket.oracle.slice(1) }));
    const goalUpgrade = qualificationGoalUpgrade(run, initialPacket);
    recordReviewEvidence(run, goalUpgrade);
    const goalAssessment = assessTask(run); assert(goalAssessment.attemptHistory, "Missing goal-upgrade assessment");
    checked("genuine-citation-does-not-excuse-confirmed-goal-upgrade", "fail", goalAssessment.attemptHistory.find(item => item.binding.checkpointHash === view.checkpointHash)?.semantic.kind);
    const question = view.choices[0]; assert(question);
    const answer = qualificationDecision(view, { kind: "answer_clarification", taskKey: question.key, originalWords: "The discussion should seek a limited pilot, not an annual procurement commitment." });
    const answerResult = await recordDecision({ run, decision: answer }); checked("lost-response-read-only-recovery", "decision_completed", answerResult.kind);
    checked("lost-response-no-second-post", 1, commands.filter(command => command.action === "submit_clarification").length);
    const worker = child("worker-clarification", ["--import", "tsx", "scripts/clarification-worker.ts", "--once"], app, environment, 30_000);
    checked("actual-postgres-fake-worker", 0, await worker.exited);
    view = qualificationView.parse(await advance(run)); checked("actual-worker-candidate-awaits-apply", "clarification_wait", view.step);
    const candidate = view.choices[0]; assert(candidate);
    await recordDecision({ run, decision: qualificationDecision(view, { kind: "apply_clarification", candidateKey: candidate.key }) });
    view = qualificationView.parse(await advance(run)); checked("apply-is-not-accept", "review_required", view.workspace.project.phase);
    await recordDecision({ run, decision: qualificationDecision(view, { kind: "accept_understanding", versionKey: view.workspace.currentVersionId }) });
    view = qualificationView.parse(await advance(run)); const positioning = view.workspace.positioning; assert(positioning);
    const recommendation = positioning.proposal.recommendation; assert(recommendation, "Against-recommendation control requires an actual recommended direction");
    const againstRecommendation = positioning.proposal.directions.find(direction => direction.id !== recommendation.directionId); assert(againstRecommendation);
    await recordDecision({ run, decision: qualificationDecision(view, { kind: "choose_positioning", choiceKey: againstRecommendation.id }) });
    view = qualificationView.parse(await advance(run));
    checked("user-can-choose-against-recommendation", againstRecommendation.id, view.workspace.positioning?.appliedDirectionId);
    checked("initial-story-is-only-candidate", null, view.workspace.story?.head.storyId);
    const prematureDeck = workspaceCommandSchema.parse({ action: "create_story_deck", commandId: randomUUID(), expected: view.workspace.story?.head });
    const rejected = await globalThis.fetch(origin + "/api/workspace", { method: "POST", headers: headers(), body: JSON.stringify(prematureDeck) });
    checked("no-deck-before-apply", 409, rejected.status);
    const rejection = z.object({ code: z.string(), error: z.string() }).parse(await rejected.json());
    checked("no-deck-refusal-is-the-adoption-gate", { code: "CONFLICT", error: "Apply a story before creating a deck." }, rejection);
    checked("rejected-create-retains-no-deck", null, (await readWorkspace()).deck ?? null);
    const initialStory = qualificationPacket(run, view.checkpointHash, reviewer);
    const failedOriginal: ReviewPacket = { ...initialStory, oracle: initialStory.oracle.map(item => ({ ...item, verdict: "violated", reason: "Known negative control: reviewer confirms omitted approval limit and proposal upgraded to achievement." })) };
    recordReviewEvidence(run, failedOriginal);
    checked("confirmed-critical-limit-or-goal-upgrade-fails", "fail", assessTask(run).semantic.kind);
    const initialChoice = view.choices[0]; assert(initialChoice);
    await recordDecision({ run, decision: qualificationDecision(view, { kind: "apply_story", candidateKey: initialChoice.key }) });
    view = qualificationView.parse(await advance(run)); const adoptedInitial = view.workspace.story?.head.storyId; assert(adoptedInitial);
    await recordDecision({ run, decision: qualificationDecision(view, { kind: "feedback", storyKey: adoptedInitial, observedCheckpointHash: view.checkpointHash, originalWords: "Lead with a proposed pilot; approval and outcomes remain unknown.", mustChange: [privateFeedbackMarker], mustPreserve: [privateFeedbackMarker], mustNot: [privateFeedbackMarker] }) });
    view = qualificationView.parse(await advance(run)); checked("revision-does-not-silently-adopt", adoptedInitial, view.workspace.story?.head.storyId);
    const revision = qualificationPacket(run, view.checkpointHash, reviewer);
    await refused("edited-output-cannot-reuse-score", /REVIEW_BINDING_MISMATCH/, () => recordReviewEvidence(run, { ...initialStory, binding: { ...initialStory.binding, checkpointHash: revision.binding.checkpointHash } }));
    recordReviewEvidence(run, revision);
    const assessment = assessTask(run); assert(assessment.attemptHistory, "Missing original/revision assessment");
    checked("original-failure-retained", "fail", assessment.attemptHistory.find(item => item.binding.checkpointHash === failedOriginal.binding.checkpointHash)?.semantic.kind);
    checked("revision-has-own-passing-control", "pass", assessment.attemptHistory.find(item => item.binding.checkpointHash === revision.binding.checkpointHash)?.semantic.kind);
    const revisionChoice = view.choices[0]; assert(revisionChoice);
    await recordDecision({ run, decision: qualificationDecision(view, { kind: "apply_story", candidateKey: revisionChoice.key }) });
    view = qualificationView.parse(await advance(run)); assert(view.workspace.story && view.workspace.deck);
    const deckContext = readWorkflowReviewContext(run), deckOperation = deckContext.operations.find(item => item.operation.command.action === "create_story_deck");
    assert(deckOperation, "Missing actual workflow Deck operation");
    const captured = deckContext.collectorEnds.find(item => item.operationId === deckOperation.operation.operationId);
    assert(captured, "Missing runtime-owned Deck interval");
    const deckCommandId = deckOperation.operation.command.commandId; assert(deckCommandId);
    const capture: ProviderCapture = { kind: "provider_capture", id: randomUUID(), at: new Date().toISOString(), actorId: reviewer.calibration.actorId, authorityHash: hashTaskValue(reviewer.authority),
      producer: "synthetic_test_collector_v1", sessionId: deckContext.reference.sessionId, sourceHash: hashTaskValue(deckContext.manifest.identity.source), runtimeHash: hashTaskValue(deckContext.binding.instance), projectId: deckContext.binding.projectId,
      commandId: deckCommandId, fromCheckpoint: deckOperation.operation.checkpointHash, toCheckpoint: deckOperation.checkpointHash, startMarker: hashTaskValue(null), events: [], terminal: { count: 0, previous: hashTaskValue(null), hash: hashTaskValue(null) } };
    capture.startMarker = hashTaskValue(providerCaptureHeader(capture)); let previous = capture.startMarker;
    capture.events = captured.events.map((event, sequence) => { const body = { ...event, sequence, previous }; const hash = hashTaskValue(body); previous = hash; return { ...body, hash }; });
    capture.terminal = { count: capture.events.length, previous, hash: hashTaskValue({ count: capture.events.length, previous, startMarker: capture.startMarker }) };
    checked("actual-synthetic-deck-provider-interval", "pass", checkProviderCapture(deckContext, capture, deckOperation).status);
    recordReviewEvidence(run, capture);
    const story = view.workspace.story.versions.find(item => item.id === view.workspace.story?.head.storyId); assert(story);
    const deckInput = { story: story.story, storyId: story.id, generation: view.workspace.story.head.generation, deck: view.workspace.deck.proposal };
    checked("exact-adopted-story-deck", [], compareAdoptedDeck(deckInput));
    assert(view.workspace.deck.proposal.schemaVersion === 2); const page = view.workspace.deck.proposal.pages[0]; assert(page);
    const missingPage = compareAdoptedDeck({ ...deckInput, deck: { ...view.workspace.deck.proposal, pages: view.workspace.deck.proposal.pages.slice(1) } });
    const changedBody = compareAdoptedDeck({ ...deckInput, deck: { ...view.workspace.deck.proposal, pages: [{ ...page, body: "Altered meaning" }, ...view.workspace.deck.proposal.pages.slice(1)] } });
    checked("missing-story-block-fails", true, missingPage.length > 0);
    checked("changed-deck-body-fails", true, changedBody.length > 0);
    write("deck-negative-controls.json", { missingPage, changedBody });
    await recordDecision({ run, decision: qualificationDecision(view, { kind: "record_review", originalWords: "Scripted tool qualification; no real user reviewed this." }) });
    view = qualificationView.parse(await advance(run));
    await recordDecision({ run, decision: qualificationDecision(view, { kind: "use_not_observed", reason: "Synthetic qualification has no real downstream use." }) });
    checked("full-workflow-finished", "finished", (await advance(run)).kind);
    checked("synthetic-user-result-stays-pending", "awaiting_observation", assessTask(run).userTask.kind);
    const qualifiedAssessment = assessTask(run); assert(qualifiedAssessment.engineering.checks, "Missing complete engineering checks");
    checked("no-unexpected-engineering-failures", [], qualifiedAssessment.engineering.checks.filter(check => check.status === "fail"));
    checked("no-incomplete-engineering-checks", [], qualifiedAssessment.engineering.checks.filter(check => check.status === "incomplete"));
    checked("complete-engineering-positive-control", "pass", qualifiedAssessment.engineering.kind);
    const beforeRestart = await readWorkspace(), auditBefore = audit(run), beforeCount = commands.length;
    const inspectBrowserDeck = async () => {
      const browser = await chromium.launch({ executablePath: process.env.PIT56_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
      try {
        const browserContext = await browser.newContext({ extraHTTPHeaders: headers() });
        browserContext.setDefaultTimeout(15_000);
        await browserContext.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await browserContext.newPage(); await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Deck", exact: true }).click();
        await page.getByRole("button", { name: "Review complete deck", exact: true }).click();
        const pages = await page.locator("article.deckPaper").evaluateAll(elements => elements.map(element => ({ title: element.querySelector("h2")?.textContent, body: element.querySelector("p")?.textContent })));
        const expected = story.story.blocks.map(block => ({ title: block.title, body: block.body }));
        assert.deepEqual(pages, expected, "Actual Deck UI changed or omitted adopted Story text");
        await browserContext.close(); return { allSavedPageTextHash: hashTaskValue(pages), pageCount: pages.length, recordings: false, runtime: "postgres-fake" };
      } finally { await browser.close(); }
    };
    const browserBefore = await inspectBrowserDeck();
    const priorServerPid = web.identity.pid;
    await stop(web.server); web = await startWeb("web-restarted");
    checked("service-restart-has-a-new-process", true, web.identity.pid !== priorServerPid);
    checked("actual-service-restart-readback", hashTaskValue(beforeRestart), hashTaskValue(await readWorkspace()));
    checked("isolated-browser-restart-retains-deck", browserBefore, await inspectBrowserDeck());
    checked("restart-local-audit-readonly", hashTaskValue(auditBefore), hashTaskValue(audit(run)));
    checked("restart-does-not-generate", beforeCount, commands.length);
    const staleHeaders = { ...headers(), "x-pitchroom-eval-instance": randomUUID() };
    checked("runtime-mismatch-rejected", 409, (await localFetch(origin + "/api/workspace", { headers: staleHeaders })).status);
    const context = readWorkflowReviewContext(run), freshTemplate = targetAt(context, revision.binding.checkpointHash);
    for (const field of ["codeFingerprintHash", "promptFingerprintHash", "modelConfigHash", "outputHash"] as const) await refused(`stale-${field}-refused`, /REVIEW_BINDING_MISMATCH/, () => recordReviewEvidence(run, { ...revision, id: randomUUID(), binding: { ...revision.binding, [field]: hashTaskValue("different-version") } }));
    await refused("stale-oracle-score-refused", /REVIEW_BINDING_MISMATCH/, () => recordReviewEvidence(run, { ...revision, binding: { ...revision.binding, caseBinding: { ...revision.binding.caseBinding, oracleHash: hashTaskValue("different-oracle") } } }));
    assert.equal(hashTaskValue(freshTemplate.binding), hashTaskValue(revision.binding));
    await refused("changed-frozen-oracle-refused", /FROZEN_BINDING_MISMATCH/, () => parseTaskBundle({ ...bundle, oracle: { ...bundle.oracle, items: bundle.oracle.items.map(item => ({ ...item, rationale: "changed frozen oracle" })) } }));
    await refused("synthetic-cannot-inherit-real-R1", /FROZEN_BINDING_MISMATCH/, () => parseTaskBundle({ ...bundle, taskCase: { ...bundle.taskCase, spec: { ...bundle.taskCase.spec, caseKind: "real_self_test", participantMode: "assisted_self_test" } } }));
    checked("formal-qualification-is-tool-validation", "tool_validation", audit(run).purpose);
    await qualifyFaultsAndTransport({ evidence, run, bundle, binding: { ...binding, instance: web.identity }, accountingPolicyFile, write, checked, refused });
    const built = ["workspace", "health"].map(route => {
      const candidates = [`apps/web/.next-qa/dev/server/app/api/${route}/route.js`, `apps/web/.next-qa/server/app/api/${route}/route.js`].filter(path => existsSync(join(app, path)));
      assert.equal(candidates.length, 1, "Actual isolated development route compilation must be unambiguous");
      const path = candidates[0]; assert(path); return { path, sha256: hashTaskBytes(readFileSync(join(app, path))) };
    });
    write("running-build.json", { kind: "actual-next-development-compilation", sourceHash, built, node: process.version, workerEntrypointHash: hashTaskBytes(readFileSync(join(app, "scripts/clarification-worker.ts"))), lockfileHash: hashTaskBytes(readFileSync(join(app, "pnpm-lock.yaml"))), notProductionBuild: true });
    write("workflow-result.json", { run, audit: audit(run), assessment: assessTask(run), transportCommandCount: commands.length, noRealR1: true });
    await stop(web.server);
  } finally {
    runController.abort(); releaseFirstMutation?.();
    try { await firstAdvance?.catch(error => write("interrupted-advance.json", { error: error instanceof Error ? error.message : String(error) })); }
    finally { collector.dispose(); globalThis.fetch = nativeFetch; }
  }
}

async function qualifyFaultsAndTransport(input: {
  evidence: string; run: Run; bundle: TaskBundle; binding: ReturnType<typeof parseWorkspaceBinding>; accountingPolicyFile: string;
  write: PersistentInputs["write"]; checked: PersistentInputs["checked"]; refused: PersistentInputs["refused"];
}) {
  const { evidence, run, bundle, write, checked, refused } = input;
  const policy = loadEvidencePolicy(JSON.parse(readFileSync(input.accountingPolicyFile, "utf8"))), context = readWorkflowReviewContext(run);
  const sessionRoot = join(policy.recordRoot, context.reference.sessionId), before = verifyTaskSession(policy, context.reference);
  const partial = join(sessionRoot, ".pending-PIT56-interrupted-write");
  writeFileSync(partial, '{"incomplete":', { flag: "wx", mode: 0o600 });
  const after = verifyTaskSession(policy, context.reference);
  checked("partial-file-is-not-committed", [...before.committed], [...after.committed]);
  checked("partial-file-is-visible-and-retained", true, after.uncommittedFiles.includes(".pending-PIT56-interrupted-write"));
  const bytesBeforeCapacity = byteCount(sessionRoot);
  await refused("session-capacity-refused", /EVIDENCE_CAPACITY/, () => reserveEvidenceWrite(policy, { additionalBytes: 1, sessionRoot, maximumSessionBytes: bytesBeforeCapacity }));
  await refused("global-capacity-refused", /EVIDENCE_CAPACITY/, () => reserveEvidenceWrite(policy, { additionalBytes: policy.capBytes + 1, sessionRoot, maximumSessionBytes: policy.capBytes * 2 }));
  checked("capacity-refusal-does-not-write-or-remove", bytesBeforeCapacity, byteCount(sessionRoot));
  const mismatch = new IsolatedWorkspaceClient({ binding: { ...input.binding, projectId: randomUUID() }, policy, reference: context.reference });
  await refused("wrong-project-refused", /WORKSPACE_PROJECT_OR_RUNTIME_MISMATCH/, () => mismatch.read());
  checked("project-mismatch-does-not-append", context.reference, verifyTaskSession(policy, context.reference).reference);
  await refused("external-http-refused", /External network refused/, () => fetch("https://example.invalid/pit56-unexpected"));
  const period = { checkedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" };
  const budgetPolicy = providerBudgetPolicySchema.parse({ schemaVersion: 1, acceptanceId: randomUUID(), projectId: input.binding.projectId, caseHash: hashTaskValue(bundle.binding), sourceHash: hashTaskValue(context.manifest.identity.source), provider: "synthetic", model: "synthetic-model", observedVersion: "synthetic-model", endpoint: "https://pit56.invalid/responses",
    approval: { evidenceRef: "synthetic-control-not-live-grant", approvedAt: period.checkedAt, validUntil: period.validUntil },
    pricing: { ...period, source: "https://example.invalid/synthetic-price", inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1 },
    inputCeiling: { ...period, source: "https://example.invalid/synthetic-context", tokens: 100_000 },
    limits: { requests: 1, inputTokens: 100_000, outputTokens: 16_000, microUsd: 100_000, inputTokensPerRequest: 100_000, outputTokensPerRequest: 16_000, requestMs: 5000, modelActiveMs: 5000,
      stageModelActiveMs: { understanding: 5000, clarify: 5000, positioning: 5000, story: 5000, legacy_deck: 5000 }, requestBytes: 128_000, responseBytes: 4096, ledgerBytes: 32_000 } });
  const budget = initializeProviderBudget(evidence, budgetPolicy), captured: string[] = [];
  const guardBody = (body: string) => {
    for (const marker of [privateOracleMarker, privateFeedbackMarker]) assert(!body.includes(marker), "ORACLE_CONTENT_REFUSED_AT_MOCK_TRANSPORT");
    return z.object({ model: z.literal("synthetic-model"), input: z.array(z.object({ role: z.string(), content: z.string() })) }).passthrough().parse(JSON.parse(body));
  };
  await refused("oracle-canary-refused-at-transport", /ORACLE_CONTENT_REFUSED_AT_MOCK_TRANSPORT/, () => guardBody(JSON.stringify({ model: "synthetic-model", input: [{ role: "user", content: privateOracleMarker }] })));
  await refused("feedback-oracle-canary-refused-at-transport", /ORACLE_CONTENT_REFUSED_AT_MOCK_TRANSPORT/, () => guardBody(JSON.stringify({ model: "synthetic-model", input: [{ role: "user", content: privateFeedbackMarker }] })));
  const transport: typeof fetch = async (url, options) => {
    assert.equal(String(url), budgetPolicy.endpoint); assert(options && typeof options.body === "string");
    const body = options.body; guardBody(body);
    const last = inspectProviderBudget(budget.directory, budget.policyHash).calls.at(-1); assert(last);
    assert.equal(last.reservation.requestHash, hashTaskBytes(body));
    assert.equal(last.outcome.kind, "pending"); captured.push(body);
    write("actual-model-request.json", { endpoint: budgetPolicy.endpoint, body: JSON.parse(body), requestHash: hashTaskBytes(body), transport: "injected-capture-only", externalRequests: 0 });
    throw new Error("PIT56_CAPTURED_WITHOUT_EXTERNAL_REQUEST");
  };
  const operation = { acceptanceId: budgetPolicy.acceptanceId, sessionId: context.reference.sessionId, projectId: input.binding.projectId, caseHash: budgetPolicy.caseHash, sourceHash: budgetPolicy.sourceHash, stage: "positioning" as const, commandId: "synthetic-positioning-capture" };
  const budgeted = budgetedProviderFetch({ ...budget, operation, transport });
  const snapshot = context.snapshots.at(-1)?.workspace; assert(snapshot);
  const understanding = snapshot.versions.find(version => version.id === snapshot.currentVersionId); assert(understanding);
  const runner = new ResponsesPositioningRunner({ apiKey: "test", model: "synthetic-model", baseURL: "https://pit56.invalid", fetch: budgeted });
  await refused("actual-runner-stops-at-owned-mock-transport", /PIT56_CAPTURED_WITHOUT_EXTERNAL_REQUEST/, () => runner.run({ understandingVersionId: understanding.id, understanding: understanding.proposal, chunks: snapshot.sources.flatMap(source => source.chunks) }));
  checked("actual-model-boundary-is-injected-once", 1, captured.length);
  const retained = inspectProviderBudget(budget.directory, budget.policyHash);
  checked("unknown-provider-response-is-held", "held_unknown", retained.state);
  await refused("unknown-budget-retry-refused", /BUDGET_UNKNOWN_OUTCOME/, () => budgeted(budgetPolicy.endpoint, { method: "POST", body: captured[0] }));
  checked("unknown-response-never-reissues", 1, captured.length);
  checked("unknown-budget-retained", hashTaskValue(retained), hashTaskValue(inspectProviderBudget(budget.directory, budget.policyHash)));
  const quotaPolicy = { ...budgetPolicy, acceptanceId: randomUUID() }, quota = initializeProviderBudget(evidence, quotaPolicy);
  let allowedCalls = 0;
  const quotaFetch = budgetedProviderFetch({ ...quota, operation: { ...operation, acceptanceId: quotaPolicy.acceptanceId }, transport: async () => {
    allowedCalls++; return new Response(JSON.stringify({ model: quotaPolicy.model, status: "completed", usage: { input_tokens: 12, output_tokens: 7 }, output: [] }), { status: 200 });
  } });
  const quotaRequest = { method: "POST", body: JSON.stringify({ model: quotaPolicy.model, input: "Synthetic quota control", max_output_tokens: 20 }) };
  await quotaFetch(quotaPolicy.endpoint, quotaRequest);
  await refused("call-budget-refused", /BUDGET_REQUEST_LIMIT/, () => quotaFetch(quotaPolicy.endpoint, quotaRequest));
  checked("request-budget-refuses-before-transport", 1, allowedCalls);
  write("fault-controls.json", { partialFile: partial, partialHash: hashTaskBytes(readFileSync(partial)), committedCheckpoints: after.committed.size,
    capacityRefusals: ["session", "global"], wrongProjectRefused: true, externalNetworkRefused: true, oracleLeakControlRefused: true,
    originalContract: bundle.binding, providerState: retained.state, providerCalls: retained.calls.length, providerPolicyHash: budget.policyHash, quotaPolicyHash: quota.policyHash, quotaAllowedCalls: allowedCalls });
}

async function main() {
  const evidence = z.string().refine(isAbsolute, "A new absolute evidence directory is required").parse(process.env.PIT56_EVIDENCE_DIRECTORY);
  const allocationFile = z.string().refine(isAbsolute, "Fresh explicit global evidence allocation is required").parse(process.env.PIT56_ALLOCATION_FILE);
  assert(!existsSync(evidence), "A new absolute evidence directory is required");
  assertUnlinkedPath(evidence); assertUnlinkedPath(allocationFile);
  const allocationBytes = readFileSync(allocationFile), allocation = allocationSchema.parse(JSON.parse(allocationBytes.toString("utf8")));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repository, encoding: "utf8" }).trim();
  assert.equal(allocation.head, head); assert(Date.now() - Date.parse(allocation.createdAt) >= 0 && Date.now() - Date.parse(allocation.createdAt) <= 300_000, "Allocation is stale");
  assert.equal(allocation.sourceTree, tree); assert.equal(allocation.evidenceDirectory, evidence);
  assert(allocation.countedHighWaterBytes + allocation.concurrentReservedBytes + allocation.allocatedBytes <= allocation.globalCapBytes, "Insufficient global evidence allocation including concurrent reservations");
  assertUnlinkedPath(allocation.approvalFile); assertUnlinkedPath(allocation.capacityReceiptFile);
  assert.equal(hashTaskBytes(readFileSync(allocation.approvalFile)), capacityApprovalSha256, "Exact user capacity approval required");
  const receiptBytes = readFileSync(allocation.capacityReceiptFile); assert.equal(hashTaskBytes(receiptBytes), allocation.capacityReceiptSha256);
  const receipt = z.object({ at: z.string().datetime({ offset: true }), cap_bytes: z.literal(400_000_000), counted_bytes: z.number().int().nonnegative(), missing_reservation_bytes: z.number().int().min(317_803),
    source_sha: z.string(), source_tree: z.string(), run_root: z.string(), roots: z.array(z.object({ root: z.string().refine(isAbsolute), counted_bytes: z.number().int().nonnegative() })).min(1),
  }).passthrough().parse(JSON.parse(receiptBytes.toString("utf8")));
  assert(Date.now() - Date.parse(receipt.at) >= 0 && Date.now() - Date.parse(receipt.at) <= 300_000, "All-roots capacity receipt is stale");
  assert.equal(receipt.counted_bytes, allocation.countedHighWaterBytes); assert.equal(receipt.source_sha, head); assert.equal(receipt.source_tree, tree); assert.equal(receipt.run_root, evidence);
  assert.equal(new Set(receipt.roots.map(root => root.root)).size, receipt.roots.length, "Capacity receipt must not duplicate roots");
  assert.equal(receipt.counted_bytes, receipt.roots.reduce((total, root) => total + root.counted_bytes, 0) + receipt.missing_reservation_bytes, "Capacity high-water arithmetic must retain every root and missing-evidence reservation");
  // The high-water count already includes the retained missing-evidence reservation.
  const listedReservations = Object.entries(receipt).filter(([key]) => key.endsWith("_reservation_bytes") && !["missing_reservation_bytes", "pit56_reservation_bytes"].includes(key));
  const otherReserved = listedReservations.reduce((total, [, value]) => total + z.number().int().nonnegative().parse(value), 0);
  const offlineAlreadyListed = receipt.pit56_offline_reservation_bytes === undefined ? 0 : z.number().int().min(qualificationCapacity.offlineReportBytes).parse(receipt.pit56_offline_reservation_bytes);
  assert(allocation.concurrentReservedBytes >= otherReserved + (offlineAlreadyListed ? 0 : qualificationCapacity.offlineReportBytes), "Concurrent work and this role's offline allowance must remain reserved");
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repository, encoding: "utf8" }).trim(), "", "Freeze reviewed source before execution");
  for (const directory of [app, join(app, "apps/web")]) assert(!readdirSync(directory).some(name => /^\.env(?:\.(?:local|development|production|test)(?:\.local)?)?$/.test(name)), "Environment-file discovery refused");
  const sourcePaths = execFileSync("git", ["ls-files", "-z", "--", "pitchroom-app"], { cwd: repository, encoding: "utf8", maxBuffer: 1_000_000 }).split("\0").filter(Boolean);
  for (const path of [...taskAcceptanceSourcePaths, "pitchroom-app/pnpm-lock.yaml", "pitchroom-app/scripts/qa-task-acceptance.ts", "pitchroom-app/packages/evals/src/task-acceptance/qualification.test.ts"]) assert(sourcePaths.includes(path), "Qualification source must be committed before execution");
  const source = sourcePaths.map(path => ({ path, sha256: hashTaskBytes(readFileSync(join(repository, path))) }));
  assert.equal(hashTaskValue(source), allocation.sourceHash, "Allocation source fingerprint changed");
  const nextEnvPath = "pitchroom-app/apps/web/next-env.d.ts", nextEnvBefore = readFileSync(join(repository, nextEnvPath));
  const committedNextEnv = execFileSync("git", ["show", `${head}:${nextEnvPath}`], { cwd: repository, maxBuffer: 8192 });
  assert(nextEnvBefore.equals(committedNextEnv), "Next environment types must begin at their exact Git blob");
  const nextEnvGenerated = Buffer.from(nextEnvBefore.toString("utf8").replaceAll("./.next/dev/types/", "./.next-qa/dev/types/"));
  assert(!nextEnvBefore.equals(nextEnvGenerated), "The reviewed isolated Next path substitution was not found");
  mkdirSync(evidence, { mode: 0o700 });
  const sourceHash = hashTaskValue(source), results: { id: string; expected: unknown; actual: unknown }[] = [];
  const terminalReserve = 64_000;
  const save = (name: string, value: unknown, limit: number) => {
    const bytes = JSON.stringify(value) + "\n"; assert(byteCount(evidence) + Buffer.byteLength(bytes) <= limit, "PIT56 evidence allocation exhausted");
    writeFileSync(join(evidence, name), bytes, { flag: "wx", mode: 0o600 });
  };
  const write = (name: string, value: unknown) => save(name, value, qualificationCapacity.standaloneBytes - terminalReserve);
  const checked = (id: string, expected: unknown, actual: unknown) => { results.push({ id, expected, actual }); assert.deepEqual(actual, expected, id); };
  const refused: PersistentInputs["refused"] = async (id, pattern, action) => {
    let actual: string | null = null;
    try { await action(); } catch (error) { actual = error instanceof Error ? error.message : String(error); }
    results.push({ id, expected: { errorPattern: pattern.source }, actual: { error: actual } });
    assert(actual !== null && pattern.test(actual), `${id}: expected ${pattern.source}, observed ${actual ?? "no refusal"}`);
  };
  write("identity.json", { issue: "PIT-56", head, tree, sourceHash, source, node: process.version, allocationSha256: hashTaskBytes(allocationBytes), allocation,
    capacity: { ...qualificationCapacity, outerGlobalReceipt: allocation.capacityReceiptFile, outerGlobalReceiptSha256: allocation.capacityReceiptSha256, retainedRootCount: receipt.roots.length, missingEvidenceReservationAlreadyIncluded: receipt.missing_reservation_bytes,
      innerPolicyScope: "Subordinate 24 MB workflow allowance inside the 25 MB run; not global evidence accounting." }, scope: "tool_validation; no R1, model quality, independent UI or real participant acceptance" });
  const children = new Set<ChildProcess>(), token = randomUUID().replaceAll("-", ""), container = `pit56-${token}`, databaseName = `pit52_${token}`;
  const childCompletions = new Set<Promise<number | null>>();
  const groupExists = (pid: number) => {
    try { process.kill(-pid, 0); return true; }
    catch (error) { if (z.object({ code: z.literal("ESRCH") }).safeParse(error).success) return false; throw error; }
  };
  let containerStarted = false;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 8192 }).trim();
  function child(name: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv, timeoutMs = 180_000) {
    const instance = spawn(process.execPath, args, { cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] }); children.add(instance);
    let count = 0, childFailure: Error | undefined;
    const kill = () => { if (instance.pid) { try { process.kill(-instance.pid, "SIGKILL"); } catch (error) { if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) throw error; } } };
    const log = (chunk: Buffer) => {
      count += chunk.length;
      if (childFailure) return;
      try {
        if (count > 32_000 || byteCount(evidence) + chunk.length > qualificationCapacity.standaloneBytes - terminalReserve) throw new Error("CHILD_EVIDENCE_BUDGET_EXCEEDED");
        appendFileSync(join(evidence, `${name}.log`), chunk, { mode: 0o600 });
      } catch (error) {
        childFailure = new Error(`${name}: ${error instanceof Error ? error.message : String(error)}; received ${count} log bytes; unretained chunk ${chunk.length} bytes sha256=${hashTaskBytes(chunk)}`);
        kill();
      }
    };
    instance.stdout.on("data", log); instance.stderr.on("data", log);
    const timer = setTimeout(() => { childFailure = new Error(`${name}: CHILD_RUNTIME_DEADLINE_EXCEEDED`); kill(); }, timeoutMs);
    const exited = new Promise<number | null>((done, reject) => {
      instance.once("error", error => { clearTimeout(timer); reject(error); });
      instance.once("close", code => { clearTimeout(timer); childFailure ? reject(childFailure) : done(code); });
    });
    childCompletions.add(exited); void exited.catch(() => undefined); return { instance, exited, kill };
  }
  const stop: PersistentInputs["stop"] = async running => {
    const pid = running.instance.pid; assert(pid, "Owned child was never spawned");
    if (groupExists(pid)) process.kill(-pid, "SIGTERM");
    const gracefulDeadline = Date.now() + 3000;
    while (groupExists(pid) && Date.now() < gracefulDeadline) await delay(100);
    if (groupExists(pid)) running.kill();
    await until(async () => !groupExists(pid), Boolean, 5000);
    await running.exited;
  };
  let failure: unknown;
  try {
    await qualifyPersistentWorkflow({ evidence, head, sourceHash, source, container, databaseName, docker, child, stop, write, checked, refused, markContainerStarted: () => { containerStarted = true; } });
  } catch (error) { failure = error; }
  const cleanupErrors: { message: string; stack?: string }[] = [];
  const cleanupStep = async (action: () => void | Promise<void>) => {
    try { await action(); } catch (error) { cleanupErrors.push(error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }); }
  };
  let groupsGone = false, containerRemoved = false;
  await cleanupStep(async () => {
    for (const instance of children) if (instance.pid && groupExists(instance.pid)) { try { process.kill(-instance.pid, "SIGKILL"); } catch (error) { if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) throw error; } }
    await until(async () => [...children].every(instance => !instance.pid || !groupExists(instance.pid)), Boolean, 5000);
    groupsGone = true;
  });
  for (const completed of childCompletions) await cleanupStep(async () => { await completed; });
  await cleanupStep(async () => {
    if (containerStarted && docker(["ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"])) {
      docker(["stop", "--time", "1", container]); containerRemoved = true;
    }
    const removalDeadline = Date.now() + 5000;
    while (true) {
      const remainingMs = removalDeadline - Date.now(); assert(remainingMs > 0, "Owned container removal deadline exceeded");
      const remaining = execFileSync("docker", ["ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"], { encoding: "utf8", timeout: remainingMs, maxBuffer: 4096 }).trim();
      if (remaining === "") break;
      await delay(100);
    }
  });
  await cleanupStep(() => {
    assert(groupsGone, "Runtime groups remain: refusing to restore next-env.d.ts while writers may be alive");
    const actualNextEnv = readFileSync(join(repository, nextEnvPath));
    save("next-env-runtime-delta.json", { path: nextEnvPath, gitHead: head, beforeSha256: hashTaskBytes(nextEnvBefore), allowedGeneratedSha256: hashTaskBytes(nextEnvGenerated), observedSha256: hashTaskBytes(actualNextEnv),
      exactBefore: nextEnvBefore.toString("utf8"), exactAllowedGenerated: nextEnvGenerated.toString("utf8"), ownedGroupsAbsent: true }, qualificationCapacity.standaloneBytes);
    assert(actualNextEnv.equals(nextEnvBefore) || actualNextEnv.equals(nextEnvGenerated), "Unexpected next-env.d.ts delta retained; refusing to overwrite it");
    if (actualNextEnv.equals(nextEnvGenerated)) writeFileSync(join(repository, nextEnvPath), nextEnvBefore);
    checked("frozen-source-retained-after-owned-runtime-cleanup", sourceHash, hashTaskValue(source.map(item => ({ path: item.path, sha256: hashTaskBytes(readFileSync(join(repository, item.path))) }))));
    checked("git-head-retained", head, execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim());
    checked("tracked-source-clean-after-cleanup", "", execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repository, encoding: "utf8" }).trim());
  });
  await cleanupStep(() => save("cleanup.json", { ownedProcessGroupIds: [...children].map(instance => instance.pid), ownedGroupsAbsent: groupsGone, onlyOwnedContainerRemoved: containerRemoved, evidencePreserved: true, nextEnvFinalSha256: hashTaskBytes(readFileSync(join(repository, nextEnvPath))), cleanupErrors: [...cleanupErrors] }, qualificationCapacity.standaloneBytes));
  if (failure || cleanupErrors.length) {
    save("failure.json", { outcome: "fail", primaryError: failure instanceof Error ? { message: failure.message, stack: failure.stack } : failure === undefined ? null : String(failure), cleanupErrors, attemptedChecks: results, notRun: "All workflow checks after the first failure; cleanup attempts are listed separately. No retry or evidence replacement performed." }, qualificationCapacity.standaloneBytes);
    throw failure ?? new Error("PIT56_CLEANUP_INCOMPLETE");
  }
  save("result.json", { outcome: "pass", head, sourceHash, checks: results, runtime: "postgres-fake", evidenceBeforeResultBytes: byteCount(evidence), productModels: 0, recordings: 0, actualUserAcceptance: "not_evaluated", semanticModelQuality: "not_evaluated" }, qualificationCapacity.standaloneBytes);
  process.stdout.write(JSON.stringify({ outcome: "pass", evidence, bytes: byteCount(evidence), checks: results.length }) + "\n");
}

if (process.env.PIT56_CHILD_NETWORK_GUARD) {
  const allowed = new URL(process.env.PIT56_CHILD_NETWORK_GUARD); assert.equal(allowed.hostname, "127.0.0.1");
  assert.equal(process.env.PITCHROOM_RUNTIME, "postgres-fake");
  assert.equal(process.env.OPENAI_API_KEY, undefined); assert.equal(process.env.PITCHROOM_LIVE_TRANSFER_ACK, undefined);
  const directory = z.string().refine(isAbsolute).parse(process.env.PIT56_CHILD_GUARD_DIRECTORY);
  const nonce = z.string().uuid().parse(process.env.PIT56_CHILD_GUARD_NONCE);
  const sourceHash = z.string().regex(/^[a-f0-9]{64}$/).parse(process.env.PITCHROOM_EVAL_SOURCE_HASH);
  assertUnlinkedPath(directory); assert(readdirSync(directory).length < 64, "Child guard process limit exceeded");
  const trace = join(directory, `${process.pid}.attempts.jsonl`), seed = { pid: process.pid, nonce, sourceHash, origin: allowed.origin };
  writeFileSync(trace, "", { flag: "wx", mode: 0o600 });
  let previous = hashTaskValue(seed), sequence = 0, canary = true;
  const original = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== allowed.origin) {
      const body = { pid: process.pid, sequence, nonce, canary, origin: url.origin, blockedBeforeNetwork: true };
      const event = { ...body, previous, hash: hashTaskValue({ ...body, previous }) }, bytes = JSON.stringify(event) + "\n";
      try {
        assert(statSync(trace).size + Buffer.byteLength(bytes) <= 8192, "Child transport evidence limit exceeded");
        assert(byteCount(directory) + Buffer.byteLength(bytes) <= 512_000, "Shared child transport evidence limit exceeded");
        appendFileSync(trace, bytes, { mode: 0o600 }); previous = event.hash; sequence++;
      } catch (error) {
        try { writeFileSync(join(directory, `${process.pid}.incomplete.json`), JSON.stringify({ ...seed, error: error instanceof Error ? error.message : String(error), lostAttemptHash: event.hash }), { flag: "wx", mode: 0o600 }); }
        finally { process.kill(process.pid, "SIGKILL"); }
        throw error;
      }
      throw new Error("PIT56_CHILD_EXTERNAL_NETWORK_REFUSED");
    }
    return original(input, { ...options, redirect: "error" });
  };
  assert.throws(() => globalThis.fetch("https://pit56.invalid/guard-canary"), /PIT56_CHILD_EXTERNAL_NETWORK_REFUSED/);
  canary = false;
  writeFileSync(join(directory, `${process.pid}.ready.json`), JSON.stringify({ ...seed, canaryHash: previous, externalDispatches: 0 }), { flag: "wx", mode: 0o600 });
}
// The entrypoint is intentionally inert when imported by offline qualification tests.
if (process.argv[1] && resolve(process.argv[1]) === self) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
