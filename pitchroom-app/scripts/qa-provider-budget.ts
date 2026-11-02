import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../apps/web/e2e/provider-budget-browser";
import { migrate } from "../packages/persistence/node_modules/drizzle-orm/postgres-js/migrator";
import { createDatabase, PitchroomRepository } from "../packages/persistence/src/index";
import { initializeProviderBudget, evaluationProviderReferenceHash, evaluationProviderTargetFingerprint, type ProviderBudgetPolicy } from "../packages/agent/src/index";
import { workspaceStateSchema } from "../packages/domain/src/index";
import { auditProviderBudget } from "../packages/evals/src/task-acceptance/provider-budget-audit";
import { taskAcceptanceSourcePaths } from "../packages/evals/src/task-acceptance/workflow";

const app = resolve(dirname(fileURLToPath(import.meta.url)), ".."), repo = dirname(app);
const root = process.env.PIT55_EVIDENCE_DIRECTORY;
assert(root && isAbsolute(root) && !existsSync(root), "Supply a new absolute PIT55_EVIDENCE_DIRECTORY; existing evidence is never overwritten");
mkdirSync(root, { mode: 0o700 });
const evidence = root, cap = 120_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceFiles = [...taskAcceptanceSourcePaths, "pitchroom-app/pnpm-lock.yaml"];
const source = sourceFiles.map(path => ({ path, sha256: digest(readFileSync(join(repo, path), "utf8")) }));
const sourceHash = digest(JSON.stringify(source));
const harnessFiles = ["scripts/qa-provider-budget.ts", "scripts/qa-provider-budget-transport.mjs", "apps/web/e2e/provider-budget-browser.ts"];
const harnessSource = harnessFiles.map(path => ({ path, sha256: digest(readFileSync(join(app, path), "utf8")) }));
const harnessHash = digest(JSON.stringify(harnessSource));
const runId = randomUUID().replaceAll("-", ""), container = `pit55-budget-${runId}`, databaseName = `pit55_${runId}`;
let containerStarted = false, budgetAcceptanceId: string | undefined;
const children = new Set<ChildProcess>();
function terminate(process: ChildProcess, signal: NodeJS.Signals) {
  if (!process.pid) return;
  try { globalThis.process.kill(-process.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
const checks: string[] = [];
// Reserve 60k for ledger+anchor, 16k transport, 4k preload identities, and 40k operator metadata.
function metadataCapacity(name: string, length: number, replace = false) {
  const counted = readdirSync(evidence, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name !== "transport.jsonl" && !entry.name.startsWith("preload-") && !entry.name.startsWith(`${budgetAcceptanceId}.provider-anchor`));
  const used = counted.reduce((sum, entry) => sum + statSync(join(evidence, entry.name)).size, 0);
  const old = replace && existsSync(join(evidence, name)) ? statSync(join(evidence, name)).size : 0;
  assert(used - old + length <= (name === "failure.json" ? 40_000 : 39_000), "Operator metadata allowance exceeded");
}
const write = (name: string, value: unknown) => { const data = JSON.stringify(value, null, 2) + "\n"; metadataCapacity(name, Buffer.byteLength(data), true); writeFileSync(join(evidence, name), data, { mode: 0o600 }); };
const read = (name: string) => JSON.parse(readFileSync(join(evidence, name), "utf8"));
function bytes(path: string): number { return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory() ? bytes(join(path, entry.name)) : statSync(join(path, entry.name)).size), 0); }
function check(label: string) { assert(bytes(evidence) <= cap, "Evidence allowance exceeded"); checks.push(label); process.stdout.write(`${label}\n`); }
function docker(args: string[]) { return execFileSync("docker", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 4096 }).trim(); }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(action: () => Promise<T>, accepts: (value: T) => boolean, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (true) { const value = await action(); if (accepts(value)) return value; if (Date.now() >= deadline) throw new Error("Bounded readiness check timed out"); await delay(250); }
}
function child(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number) {
  const process = spawn(globalThis.process.execPath, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); children.add(process);
  let count = 0, overflow = false;
  const output = (chunk: Buffer) => {
    count += chunk.length;
    if (count > 8000) { overflow = true; terminate(process, "SIGKILL"); return; }
    try { metadataCapacity(`${name}.log`, chunk.length); } catch { overflow = true; terminate(process, "SIGKILL"); return; }
    appendFileSync(join(evidence, `${name}.log`), chunk, { mode: 0o600 });
  };
  process.stdout!.on("data", output); process.stderr!.on("data", output);
  const timer = setTimeout(() => terminate(process, "SIGKILL"), timeoutMs);
  const exit = new Promise<number | null>((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", code => { clearTimeout(timer); overflow ? reject(new Error(`${name} output cap exceeded`)) : resolve(code); });
  });
  // Keep a long-running Web failure observable without an unhandled rejection.
  void exit.catch(() => undefined);
  return { process, exit };
}
async function stop(server: ReturnType<typeof child>) {
  if (server.process.exitCode === null && server.process.signalCode === null) terminate(server.process, "SIGTERM");
  await server.exit;
}
async function freePort() {
  const socket = createServer(); await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const address = socket.address(); assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve())); return address.port;
}
async function main() {
  for (const directory of [app, join(app, "apps/web")]) assert(!readdirSync(directory).some(name => /^\.env(?:\.(?:local|development|production|test)(?:\.local)?)?$/.test(name)), "Next must not discover environment files");
  docker(["run", "--detach", "--rm", "--pull=never", "--name", container, "--label", "pitchroom.qa=pit55-synthetic", "--log-driver", "none", "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=pit55_qa", "--env", "POSTGRES_PASSWORD=test", "--env", `POSTGRES_DB=${databaseName}`, "postgres:17-alpine"]);
  containerStarted = true;
  const address = docker(["port", container, "5432/tcp"]); assert.match(address, /^127\.0\.0\.1:\d+$/);
  await until(async () => { try { return docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "pit55_qa", "-d", databaseName]).includes("accepting connections"); } catch { return false; } }, Boolean, 20_000);
  const port = address.split(":")[1];
  const databaseURL = `postgres://pit55_qa:test@127.0.0.1:${port}/${databaseName}`;
  const database = createDatabase(databaseURL);
  let projectId: string, chunk: { id: string; sourceId: string; text: string };
  try {
    const identity = await database.client`select current_database() as name`;
    assert.equal(identity[0]!.name, databaseName);
    await migrate(database.db, { migrationsFolder: join(app, "packages/persistence/migrations") });
    const repository = new PitchroomRepository(database.db), project = await repository.ensureProject("atelier", "PIT55 synthetic QA");
    projectId = project.id;
    await repository.addMaterial(project.id, { name: "synthetic-pilot.md", mediaType: "text/markdown", text: "Northwind proposes a two-week pilot. Approval and outcomes are unknown." }, randomUUID());
    chunk = (await repository.listSources(project.id))[0]!.chunks[0]!;
  } finally { await database.client.end(); }
  const question = { question: "Who approves the proposed pilot?", whyItMatters: "Approval remains unknown.", relatedThemeIndexes: [0] };
  const fixture = { mode: "invalid-draft", delayMs: 1600, chunk,
    understanding: { proposal: { schemaVersion: 1, themes: [{ title: "Pilot", summary: "A pilot is proposed; approval and outcomes remain unknown.", claims: [{ statement: chunk.text, evidenceState: "supported", evidence: [{ sourceId: chunk.sourceId, chunkId: chunk.id, quote: chunk.text }], userInputIds: [] }] }], gaps: [{ description: "Pilot approval remains unknown.", whyItMatters: "A proposal does not establish approval.", relatedSourceIds: [chunk.sourceId] }], topicTasks: [{ id: "pit55-pilot-question", themeIndex: 0, relatedGapIndexes: [0], question }], nextQuestion: question }, publicSummary: "Synthetic pilot with approval still unknown." },
    clarify: { draftVersion: 1, bases: [{ id: "A", origin: "agent", nature: "interpretation", statement: "No new information justifies a change.", scope: "This answer only" }], basisRefs: ["A"], changes: [], corrections: [], question: null } };
  write("response-fixture.json", fixture);
  const caseHash = digest(JSON.stringify({ chunk, purpose: "synthetic transport engineering only" }));
  const policy: ProviderBudgetPolicy = { schemaVersion: 1, acceptanceId: randomUUID(), projectId, caseHash, sourceHash,
    provider: "synthetic-test-only", model: "synthetic-model", observedVersion: "synthetic-model", endpoint: "https://pit55-synthetic.deepseek.com/responses",
    approval: { evidenceRef: "synthetic-test-only-no-live-grant", approvedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" },
    pricing: { source: "https://synthetic.invalid/pricing", checkedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z", inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 },
    inputCeiling: { tokens: 100_000, source: "https://synthetic.invalid/context", checkedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" },
    limits: { requests: 6, inputTokens: 1_000_000, outputTokens: 100_000, microUsd: 2_000_000, inputTokensPerRequest: 100_000, outputTokensPerRequest: 16_000, requestMs: 5000, modelActiveMs: 60_000, stageModelActiveMs: { understanding: 30_000, clarify: 30_000, positioning: 30_000, story: 30_000, legacy_deck: 30_000 }, requestBytes: 262144, responseBytes: 262144, ledgerBytes: 60_000 } };
  budgetAcceptanceId = policy.acceptanceId;
  const budget = initializeProviderBudget(evidence, policy);
  let reference = { schemaVersion: 1, ...budget, sessionId: randomUUID(), instanceId: randomUUID(), sourceHash, caseHash, targetFingerprint: evaluationProviderTargetFingerprint(databaseURL) };
  write("reference.json", reference); write("source.json", source); write("harness-source.json", harnessSource);
  const origin = `http://127.0.0.1:${await freePort()}`;
  const environment = () => ({ PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PITCHROOM_RUNTIME: "live", PITCHROOM_ISOLATED_QA: "1", NEXT_TELEMETRY_DISABLED: "1",
    PITCHROOM_LIVE_TRANSFER_ACK: "authorized", OPENAI_API_KEY: "test", OPENAI_MODEL: policy.model, OPENAI_BASE_URL: "https://pit55-synthetic.deepseek.com", DATABASE_URL: databaseURL,
    PITCHROOM_EVAL_BUDGET_FILE: join(evidence, "reference.json"), PITCHROOM_EVAL_INSTANCE_ID: reference.instanceId, PITCHROOM_EVAL_SOURCE_HASH: sourceHash, PITCHROOM_EVAL_CASE_HASH: caseHash, PITCHROOM_EVAL_REFERENCE_HASH: evaluationProviderReferenceHash(reference),
    PIT55_SYNTHETIC_ROOT: evidence, PIT55_LOOPBACK_ORIGIN: origin, NODE_OPTIONS: `--import=${join(app, "scripts/qa-provider-budget-transport.mjs")}` });
  const headers = () => ({ "content-type": "application/json", "x-pitchroom-eval-instance": reference.instanceId, "x-pitchroom-eval-source": sourceHash, "x-pitchroom-eval-target": reference.targetFingerprint, "x-pitchroom-eval-budget": evaluationProviderReferenceHash(reference) });
  const audit = () => auditProviderBudget(budget);
  async function startWeb(name: string) {
    const server = child(name, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", new URL(origin).port], join(app, "apps/web"), environment(), 240_000);
    const health = await until(async () => { try { const response = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(3000) }); return response.ok ? await response.json() : null; } catch { return null; } }, value => value?.status === "ready");
    const identity = health.evaluationBudgetInstance;
    assert.equal(identity.referenceHash, evaluationProviderReferenceHash(reference)); assert.equal(identity.acceptanceId, policy.acceptanceId);
    assert.equal(health.evaluationInstance, undefined); assert.equal(read(`preload-${identity.pid}.json`).transport, "synthetic_injected");
    write(`${name}-identity.json`, identity); return server;
  }
  const state = async () => { const response = await fetch(origin + "/api/workspace", { headers: headers(), signal: AbortSignal.timeout(30_000) }); assert.equal(response.status, 200); return workspaceStateSchema.parse(await response.json()); };
  async function command(body: unknown, expectedStatus = 200) { const response = await fetch(origin + "/api/workspace", { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }); assert.equal(response.status, expectedStatus, "Unexpected synthetic command HTTP status"); return workspaceStateSchema.parse(await response.json()); }
  async function worker(name: string, override: NodeJS.ProcessEnv = {}) {
    // tsx must register before the synthetic preload for an actual TypeScript entrypoint.
    return child(name, ["--import", "tsx", "--import", join(app, "scripts/qa-provider-budget-transport.mjs"), "scripts/clarification-worker.ts", "--live", "--once"], app, { ...environment(), NODE_OPTIONS: "", ...override }, 20_000).exit;
  }
  let server = await startWeb("web-first");
  const wrong = await fetch(origin + "/api/workspace", { method: "POST", headers: { ...headers(), "x-pitchroom-eval-budget": "wrong" }, body: JSON.stringify({ action: "run", commandId: randomUUID() }) }); assert.equal(wrong.status, 409);
  assert.equal(await worker("worker-refused", { PITCHROOM_EVAL_REFERENCE_HASH: "0".repeat(64) }), 1); assert.equal(audit().calls.length, 0);
  check("wrong Web binding and worker launch refused before any provider request");
  const idle = child("worker-continuous", ["--import", "tsx", "--import", join(app, "scripts/qa-provider-budget-transport.mjs"), "scripts/clarification-worker.ts", "--live"], app, { ...environment(), NODE_OPTIONS: "" }, 30_000);
  await delay(2000); assert.equal(idle.process.exitCode, null);
  let current = await command({ action: "run", commandId: "pit55-understanding" });
  assert.equal(current.project.phase, "review_required"); assert.equal(audit().calls.length, 2);
  assert.equal(idle.process.exitCode, null); assert.equal(idle.process.signalCode, null);
  await stop(idle); assert.equal(await idle.exit, 0);
  check("admitted polling worker survives ordinary in-flight Web reservations without claiming or spending");
  check("actual Web Understanding tool loop made two durably reserved provider requests");
  const answer = "I do not know; leave this open.";
  current = await command({ action: "submit_clarification", commandId: "pit55-first-answer", text: answer, expectedRevision: current.project.revision, selection: { understandingId: current.currentVersionId, taskId: "pit55-pilot-question", themeIndex: 0 } }, 202);
  assert.equal(await worker("worker-invalid-draft"), 0); current = await state();
  const task = current.clarifications!.at(-1)!; assert.equal(task.status, "failed"); assert.equal(audit().calls.length, 3);
  const browser = await chromium.launch({ executablePath: process.env.PIT55_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  async function page() {
    const context = await browser.newContext({ extraHTTPHeaders: headers() });
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Clarify", exact: true }).click();
    await page.getByRole("button", { name: "Retry saved answer", exact: true }).waitFor();
    assert((await page.locator("body").innerText()).includes(answer)); return { page, context };
  }
  try {
    const first = await page(); await first.context.close();
    const before = audit(); write("before-recovery.json", before);
    await stop(server);
    const oldHeaders = headers(); reference = { ...reference, sessionId: randomUUID(), instanceId: randomUUID() }; write("reference.json", reference);
    server = await startWeb("web-recovered");
    assert.equal((await fetch(origin + "/api/workspace", { headers: oldHeaders })).status, 409);
    assert.deepEqual(audit(), before);
    const recovered = await page();
    fixture.mode = "valid"; write("response-fixture.json", fixture);
    await recovered.page.getByRole("button", { name: "Retry saved answer", exact: true }).click();
    await until(state, value => value.clarifications?.some(item => item.id === task.id && item.status === "queued") === true, 10_000);
    assert.equal(await worker("worker-retry"), 0); current = await state();
    const retried = current.clarifications!.find(item => item.id === task.id)!;
    assert.equal(retried.status, "no_change"); assert.equal(retried.answer, answer); assert.equal(retried.attempts.length, 2);
    const latest = audit().calls.at(-1)!;
    assert.equal(latest.commandId, retried.attempts[1]!.commandId); assert.notEqual(latest.commandId, task.commandId);
    assert.deepEqual(latest.workerAttempt, { taskId: task.id, attemptId: retried.attempts[1]!.id });
    assert.equal(audit().sessions.length, 2); assert.equal(audit().calls.length, 4);
    await recovered.context.close();
    check("fresh browser and runtime retain original budget; explicit worker retry uses new session and attempt");
  } finally { await browser.close(); }
  current = await command({ action: "dismiss_clarification", taskId: task.id, commandId: "pit55-close-no-change" });
  fixture.mode = "missing-usage"; write("response-fixture.json", fixture);
  current = await command({ action: "submit_clarification", commandId: "pit55-unknown-usage", text: answer, expectedRevision: current.project.revision, selection: { understandingId: current.currentVersionId, taskId: "pit55-pilot-question", themeIndex: 0 } }, 202);
  assert.equal(await worker("worker-missing-usage"), 0);
  const held = audit(); assert.equal(held.state, "held_unknown"); assert.equal(held.calls.length, 5);
  assert.equal(held.calls.at(-1)!.inputTokens, 100_000); assert.equal(held.calls.at(-1)!.outcome, "unknown");
  assert.equal(await worker("worker-held-refusal"), 1); assert.deepEqual(audit(), held);
  check("missing provider usage retains conservative reservation and restart makes no new claim/request");
  const captures = readFileSync(join(evidence, "transport.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(captures.length, held.calls.length);
  assert.deepEqual(captures.map(item => item.callId), held.calls.map(item => item.callId));
  for (const item of captures) assert.equal(item.forbiddenLiteralsAbsent, true);
  assert.deepEqual(sourceFiles.map(path => ({ path, sha256: digest(readFileSync(join(repo, path), "utf8")) })), source);
  assert.deepEqual(harnessFiles.map(path => ({ path, sha256: digest(readFileSync(join(app, path), "utf8")) })), harnessSource);
  write("final-audit.json", held);
  assert(bytes(evidence) <= cap); await stop(server);
  return { outcome: "pass", sourceHash, harnessHash, caseHash, acceptanceId: policy.acceptanceId, runtime: "live", transport: "synthetic_injected", checks, requestCount: captures.length, browserRecording: false, liveAdmission: "not_granted", taskAcceptance: "not_evaluated", modelQuality: "not_evaluated" };
}
async function execute() {
  let result: Awaited<ReturnType<typeof main>> | undefined, failure: unknown;
  try { result = await main(); } catch (error) { failure = error; }
  try {
    for (const process of children) terminate(process, "SIGKILL");
    await until(async () => [...children].every(process => { try { globalThis.process.kill(-process.pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } }), Boolean, 5000);
    if (containerStarted) {
      docker(["stop", "--time", "1", container]);
      const removalDeadline = Date.now() + 5000;
      let remainingContainer = container;
      while (remainingContainer) {
        const remainingMs = removalDeadline - Date.now();
        assert(remainingMs > 0, `Owned container removal timed out: ${container} (${remainingContainer})`);
        remainingContainer = execFileSync("docker", ["ps", "--all", "--filter", `name=^/${container}$`, "--format", "{{.ID}}"], { encoding: "utf8", timeout: remainingMs, maxBuffer: 4096 }).trim();
        if (remainingContainer) await delay(100);
      }
    }
    write("cleanup.json", { ownedProcessGroupsStopped: true, ownedContainerRemoved: containerStarted });
  } catch (error) { failure ??= error; }
  if (failure || !result) {
    write("failure.json", { outcome: "fail", checks, error: (failure instanceof Error ? failure.message : "Unknown harness failure").slice(0, 600) }); process.exitCode = 1;
  } else write("result.json", result);
  process.stdout.write(`Evidence: ${evidence}\n`);
}
void execute().catch(() => { process.stderr.write("Synthetic harness failed to preserve its terminal receipt.\n"); process.exitCode = 1; });
