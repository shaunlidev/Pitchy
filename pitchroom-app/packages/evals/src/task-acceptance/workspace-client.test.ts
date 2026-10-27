import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GET, POST } from "../../../../apps/web/app/api/workspace/route";
import { healthResponse } from "../../../../apps/web/app/api/health/route";
import { evaluationInstance } from "../../../../apps/web/lib/evaluation-instance";
import { addFixtureMaterial, runFixtureAgent, acceptFixture, generateFixturePositioning, applyFixturePositioning, proposeFixtureStory, resetFixtureState } from "../../../../apps/web/lib/fixture-store";
import { loadEvidencePolicy } from "./capacity";
import { createTaskSession, verifyTaskSession } from "./session";
import { hashTaskValue } from "./schema";
import { IsolatedWorkspaceClient } from "./workspace-client";

const servers: Server[] = [], roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise<void>(done => child.once("exit", () => done())); }
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  vi.unstubAllEnvs();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  vi.stubEnv("PITCHROOM_RUNTIME", "fixture"); vi.stubEnv("PITCHROOM_EVAL_INSTANCE_ID", randomUUID()); vi.stubEnv("PITCHROOM_EVAL_SOURCE_HASH", "c".repeat(64));
  resetFixtureState();
  const instance = evaluationInstance(); if (instance.kind !== "enabled") throw new Error("Missing synthetic instance identity");
  const root = mkdtempSync(join(tmpdir(), "pit52-client-")); roots.push(root);
  mkdirSync(join(root, "history")); mkdirSync(join(root, "pitchroom-v6/evidence"), { recursive: true }); mkdirSync(join(root, "pitchroom-app/.artifacts"), { recursive: true });
  writeFileSync(join(root, "pitchroom-v6/manifest.json"), JSON.stringify({ evidencePolicy: { approvedCapBytes: 10_000_000, accountingPackageRoots: ["evidence"], accountingWorkspaceRoots: [{ path: "history", required: true }] } }));
  const policy = loadEvidencePolicy({ repositoryRoot: root, recordDirectory: "pitchroom-app/.artifacts/pit52", referenceLinks: [], legacyWriters: "quiescent" });
  const config = new URL("../../config/task-acceptance/pitchroom-r1/", import.meta.url), lockHash = hashTaskValue("test-lock");
  const reference = createTaskSession(policy, { sessionId: randomUUID(), purpose: "tool_validation", maximumBytes: 3_000_000,
    identity: { source: { head: "d".repeat(40), dirty: false, lockfileHash: lockHash, files: [{ path: "pitchroom-app/pnpm-lock.yaml", hash: lockHash }, { path: "pitchroom-app/synthetic.ts", hash: hashTaskValue("synthetic") }] }, runtime: { web: { kind: "unknown", reason: "Real route functions over a Node HTTP adapter, no Next build" }, worker: { kind: "unknown", reason: "No worker started" } } },
    bundle: { taskCase: JSON.parse(readFileSync(new URL("case.json", config), "utf8")), oracle: JSON.parse(readFileSync(new URL("oracle.json", config), "utf8")), materialPackageText: readFileSync(new URL("materials.json", config), "utf8") },
  });
  let posts = 0, loseResponse = false, redirect = false, beforePost = () => {}, beforeGet = async () => {};
  let postOverride: (() => Promise<Response>) | undefined;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === "string") headers.set(name, value);
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers, ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
      if (redirect) { outgoing.writeHead(302, { location: "http://127.0.0.1:1/forbidden" }); outgoing.end(); return; }
      let response: Response;
      if (incoming.url === "/api/health") response = await healthResponse();
      else if (incoming.method === "POST") { posts++; beforePost(); response = postOverride ? await postOverride() : await POST(request); }
      else { await beforeGet(); response = await GET(request); }
      if (incoming.method === "POST" && loseResponse) { outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch { outgoing.destroy(); }
  });
  servers.push(server); await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing local listener");
  const binding = { baseURL: `http://127.0.0.1:${address.port}/`, instance: instance.identity, projectId: "00000000-0000-4000-8000-000000000001", timeoutMs: 2000, maximumResponseBytes: 1_000_000 };
  const client = new IsolatedWorkspaceClient({ binding, policy, reference });
  return { client, policy, reference, binding, root, posts: () => posts, lose: () => { loseResponse = true; }, redirect: () => { redirect = true; }, beforePost: (callback: () => void) => { beforePost = callback; }, beforeGet: (callback: () => Promise<void>) => { beforeGet = callback; }, overridePost: (callback: () => Promise<Response>) => { postOverride = callback; } };
}
const add = (commandId = randomUUID(), expectedRevision = 0) => ({ attemptId: commandId, stage: "materials", expectedRevision, command: { action: "add_material", commandId, name: "synthetic.md", mediaType: "text/markdown", text: "Synthetic material, no real client or provider." } });

it("persists the exact command before a real HTTP route mutation, then replays its saved receipt without a second POST", async () => {
  const f = await fixture(), input = add();
  f.beforePost(() => {
    const state = verifyTaskSession(f.policy, f.client.reference);
    expect(state.observations.some(item => item.commandId === input.command.commandId && zKind(item.data) === "workspace_command_prepared")).toBe(true);
  });
  const first = await f.client.execute(input); expect(first.kind).toBe("confirmed"); expect(f.posts()).toBe(1);
  const resumed = new IsolatedWorkspaceClient({ binding: f.binding, policy: f.policy, reference: f.client.reference });
  expect(await resumed.execute(input)).toEqual(first); expect(f.posts()).toBe(1);
  await expect(resumed.execute({ ...input, command: { ...input.command, text: "changed" } })).rejects.toThrow("WORKSPACE_COMMAND_REUSE_CONFLICT");
});
function zKind(value: unknown) { return value && typeof value === "object" && "kind" in value ? value.kind : undefined; }

it("refuses wrong project, runtime or instance before sending any POST", async () => {
  const f = await fixture();
  for (const binding of [{ ...f.binding, projectId: randomUUID() }, { ...f.binding, instance: { ...f.binding.instance, instanceId: randomUUID() } }, { ...f.binding, instance: { ...f.binding.instance, runtime: "postgres-fake" } }]) {
    const client = new IsolatedWorkspaceClient({ binding, policy: f.policy, reference: f.reference });
    await expect(client.execute(add())).rejects.toThrow();
  }
  expect(f.posts()).toBe(0);
});

it("refuses an external origin or redirect without attempting a mutation", async () => {
  const f = await fixture();
  for (const baseURL of ["https://127.0.0.1:3000/", "http://localhost:3000/", "http://example.com:3000/", "http://127.0.0.1/", "http://u:p@127.0.0.1:3000/"]) expect(() => new IsolatedWorkspaceClient({ binding: { ...f.binding, baseURL }, policy: f.policy, reference: f.reference })).toThrow();
  f.redirect(); await expect(f.client.execute(add())).rejects.toThrow("WORKSPACE_REDIRECT_REFUSED"); expect(f.posts()).toBe(0);
});

it("a sensitive-input refusal happens before dispatch", async () => {
  const f = await fixture();
  await expect(f.client.execute({ ...add(), command: { ...add().command, text: "postgres://qa:synthetic@127.0.0.1:5432/test" } })).rejects.toThrow();
  expect(f.posts()).toBe(0);
});

it("global capacity exhaustion prevents dispatch without changing the limit or removing evidence", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "history/retained-synthetic-evidence"), Buffer.alloc(10_000_000));
  await expect(f.client.execute(add())).rejects.toThrow();
  expect(f.posts()).toBe(0);
  expect(readFileSync(join(f.root, "history/retained-synthetic-evidence")).length).toBe(10_000_000);
});

it("a lost unqueryable response stops the session and never spends on another generation", async () => {
  const f = await fixture(), input = add(); f.lose();
  expect(await f.client.execute(input)).toMatchObject({ kind: "outcome_unknown", reason: "unconfirmed_mutation" }); expect(f.posts()).toBe(1);
  expect((await f.client.read()).state.sources).toHaveLength(1);
  const resumed = new IsolatedWorkspaceClient({ binding: f.binding, policy: f.policy, reference: f.client.reference });
  expect(await resumed.execute(input)).toMatchObject({ kind: "outcome_unknown" });
  await expect(resumed.execute({ attemptId: "new-generation", stage: "understanding", expectedRevision: 1, command: { action: "run", commandId: "new-generation" } })).rejects.toThrow("WORKSPACE_UNRESOLVED_COMMAND_HOLD");
  expect(f.posts()).toBe(1);
});

it("retains a 409 and the previous workspace instead of retrying", async () => {
  const f = await fixture();
  const before = (await f.client.read()).state;
  expect(await f.client.execute({ attemptId: "invalid-accept", stage: "understanding", expectedRevision: 0, command: { action: "accept", commandId: "invalid-accept", expectedRevision: 0 } })).toEqual({ kind: "conflict", status: 409 });
  expect((await f.client.read()).state).toEqual(before); expect(f.posts()).toBe(1);
});

it("prevents concurrent use of one client and rejects revision disagreement before dispatch", async () => {
  const f = await fixture();
  await expect(f.client.execute({ attemptId: "mismatch", stage: "understanding", expectedRevision: 1, command: { action: "accept", commandId: "mismatch", expectedRevision: 0 } })).rejects.toThrow("WORKSPACE_EXPECTED_REVISION_MISMATCH");
  const running = f.client.execute(add()); await expect(f.client.execute(add())).rejects.toThrow("WORKSPACE_CLIENT_BUSY"); await running; expect(f.posts()).toBe(1);
});

it("two clients in the same millisecond cannot share a prepared claim and dispatch twice", async () => {
  const f = await fixture(), input = add();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  let arrivals = 0, release = () => {};
  const barrier = new Promise<void>(done => { release = done; });
  f.beforeGet(async () => { arrivals++; if (arrivals === 2) release(); await barrier; });
  const second = new IsolatedWorkspaceClient({ binding: f.binding, policy: f.policy, reference: f.reference });
  const results = await Promise.allSettled([f.client.execute(input), second.execute(input)]);
  expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(item => item.status === "rejected")).toHaveLength(1);
  expect(f.posts()).toBe(1);
  expect(verifyTaskSession(f.policy, f.reference).observations.filter(item => zKind(item.data) === "workspace_command_prepared")).toHaveLength(1);
});

it("lost clarification submission is recovered through its exact original command and payload without resending", async () => {
  const f = await fixture();
  await f.client.execute(add());
  const baseline = (await f.client.read()).state;
  const run = await f.client.execute({ attemptId: "run", stage: "understanding", expectedRevision: baseline.project.revision, command: { action: "run", commandId: "run" } });
  expect(run.kind).toBe("confirmed");
  const state = (await f.client.read()).state, version = state.versions.find(item => item.id === state.currentVersionId);
  if (!version) throw new Error("Missing deterministic Understanding");
  const task = version.proposal.topicTasks?.[0];
  const selection = task ? { understandingId: version.id, themeIndex: task.themeIndex, taskId: task.id } : undefined;
  f.lose();
  const outcome = await f.client.execute({ attemptId: "answer", stage: "clarify", expectedRevision: state.project.revision, command: { action: "submit_clarification", commandId: "answer", expectedRevision: state.project.revision, text: "Synthetic user report for diagnostics only.", ...(selection ? { selection } : {}) } });
  expect(outcome).toMatchObject({ kind: "recovered", proof: "clarification_submission" }); expect(f.posts()).toBe(3);
});

it.each(["decide_story", "propose_story"])("does not mistake retry side effects for a %s action receipt", async action => {
  const f = await fixture();
  addFixtureMaterial({ name: "synthetic.md", mediaType: "text/markdown", text: "Synthetic test material with unknown outcomes." });
  const understood = runFixtureAgent(); acceptFixture(understood.project.revision);
  const positioning = generateFixturePositioning(), direction = positioning.positioning?.proposal.directions[0];
  if (!direction) throw new Error("Missing deterministic positioning");
  const chosen = applyFixturePositioning(direction.id, positioning.project.revision);
  const expected = chosen.story?.head ?? { generation: 0, storyId: null };
  const proposed = await proposeFixtureStory({ commandId: randomUUID(), expected, request: { kind: "develop_direction" } });
  const prior = proposed.story?.proposals.at(-1); if (!prior) throw new Error("Missing synthetic Story proposal");
  const commandId = randomUUID();
  f.overridePost(async () => {
    // The original request never executes. A different retry action reuses its ID.
    const changed = await proposeFixtureStory({ commandId, expected, request: { kind: "develop_direction" }, retryOf: prior.id });
    return Response.json(changed, { headers: { "x-pitchroom-mode": "fixture" } });
  });
  f.lose();
  const command = action === "decide_story" ? { action, commandId, expected, proposalId: prior.id, decision: "keep_current" } : { action, commandId, expected, request: { kind: "develop_direction" } };
  expect(await f.client.execute({ attemptId: commandId, stage: "story_initial", expectedRevision: proposed.project.revision, command })).toEqual({ kind: "outcome_unknown", reason: "unconfirmed_mutation" });
  const current = (await f.client.read()).state;
  expect(current.story?.proposals.find(item => item.id === prior.id)?.state).toEqual({ kind: "kept", commandId });
  expect(current.story?.proposals.some(item => item.commandId === commandId)).toBe(true);
  expect(f.posts()).toBe(1);
});

it("SIGKILL after durable prepare and dispatch cannot cause a second POST after process restart", async () => {
  const f = await fixture(), input = add();
  const modulePath = new URL("./workspace-client.ts", import.meta.url).href;
  const capacityPath = new URL("./capacity.ts", import.meta.url).href;
  const source = `import {IsolatedWorkspaceClient} from ${JSON.stringify(modulePath)}; import {loadEvidencePolicy} from ${JSON.stringify(capacityPath)}; process.once('message',async data=>{try { const client=new IsolatedWorkspaceClient({binding:data.binding,reference:data.reference,policy:loadEvidencePolicy(data.policy)});await client.execute(data.input);process.send({unexpectedCompletion:true});}catch{process.send({unexpectedFailure:true});}});`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: fileURLToPath(new URL("../../..", import.meta.url)), env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "ipc"] }); children.push(child);
  const exit = new Promise<void>((done, reject) => { child.once("error", reject); child.once("exit", (_code, signal) => signal === "SIGKILL" ? done() : reject(new Error("Child exited without controlled SIGKILL"))); });
  f.beforePost(() => { child.kill("SIGKILL"); });
  child.send({ binding: f.binding, reference: f.reference, policy: { repositoryRoot: f.root, recordDirectory: "pitchroom-app/.artifacts/pit52", referenceLinks: [], legacyWriters: "quiescent" }, input });
  await exit;
  expect(verifyTaskSession(f.policy, f.reference).observations.some(item => item.commandId === input.command.commandId)).toBe(true);
  const resumed = new IsolatedWorkspaceClient({ binding: f.binding, policy: f.policy, reference: f.reference });
  expect(await resumed.execute(input)).toMatchObject({ kind: "outcome_unknown" });
  expect(f.posts()).toBe(1); expect((await resumed.read()).state.sources).toHaveLength(1);
}, 10000);
