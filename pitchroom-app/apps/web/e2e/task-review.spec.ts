import { expect, test } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { evaluationInstanceSchema, workspaceStateSchema } from "@pitchroom/domain";
import { hashTaskValue, reviewBindingSchema, taskRubric } from "../../../packages/evals/src/task-acceptance/schema";
import { calibrationBank } from "../../../packages/evals/src/task-acceptance/review";

const exec = promisify(execFile);
const gateSchema = z.object({ kind: z.literal("awaiting_human"), checkpointHash: z.string(), capability: z.string(), workspace: workspaceStateSchema, choices: z.array(z.object({ key: z.string() })) });
const templateSchema = z.object({ binding: reviewBindingSchema, authorityHash: z.string(), fields: z.array(z.object({ pointer: z.string(), valueHash: z.string(), classification: z.string() })), oracle: z.array(z.object({ id: z.string() })) });
test("failed Deck review survives a real browser edit and requires a new CLI-bound review", async ({ browser }) => {
  test.setTimeout(120000);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit54-browser-"))), web = process.cwd(), repository = resolve(web, "../../.."), evals = resolve(web, "../../packages/evals");
  const listener = createServer(); await new Promise<void>(done => listener.listen(0, "127.0.0.1", done));
  const address = listener.address(); if (!address || typeof address === "string") throw new Error("No owned port");
  await new Promise<void>(done => listener.close(() => done()));
  const baseURL = `http://127.0.0.1:${address.port}`, instanceId = randomUUID();
  const localDev = process.env.PIT54_BROWSER_LOCAL_DEV === "1";
  const server = spawn(process.execPath, [resolve(web, "node_modules/next/dist/bin/next"), ...(localDev ? ["dev", "--webpack"] : ["start"]), "--hostname", "127.0.0.1", "--port", String(address.port)], {
    cwd: web, detached: true, stdio: "ignore", env: { NODE_ENV: localDev ? "development" : "production", ...(localDev ? { PITCHROOM_ISOLATED_QA: "1" } : {}), PATH: process.env.PATH, HOME: process.env.HOME, PITCHROOM_RUNTIME: "fixture", PITCHROOM_EVAL_INSTANCE_ID: instanceId, PITCHROOM_EVAL_SOURCE_HASH: hashTaskValue("PIT54 isolated browser runtime"), NEXT_TELEMETRY_DISABLED: "1" },
  });
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    let identity: z.infer<typeof evaluationInstanceSchema> | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error("Owned fixture server exited");
      try { const response = await fetch(`${baseURL}/api/health`); identity = z.object({ evaluationInstance: evaluationInstanceSchema }).parse(await response.json()).evaluationInstance; break; } catch { await new Promise(done => setTimeout(done, 100)); }
    }
    if (!identity || identity.instanceId !== instanceId || !server.pid) throw new Error("Owned fixture identity handshake failed");
    const group = (await exec("ps", ["-o", "pgid=", "-p", String(identity.pid)], { env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: process.env.HOME } })).stdout.trim();
    if (Number(group) !== server.pid) throw new Error("Fixture identity belongs to another process group");
    const headers = { "x-pitchroom-eval-instance": identity.instanceId, "x-pitchroom-eval-source": identity.sourceFingerprint, "x-pitchroom-eval-target": identity.targetFingerprint };
    context = await browser.newContext({ baseURL, extraHTTPHeaders: headers }); const page = await context.newPage();
    const state = workspaceStateSchema.parse(await (await fetch(`${baseURL}/api/workspace`, { headers })).json());
    for (const folder of ["pitchroom-v6/evidence", "history", "pitchroom-app/.artifacts"]) mkdirSync(join(root, folder), { recursive: true });
    const save = (name: string, value: unknown) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
    save("pitchroom-v6/manifest.json", { evidencePolicy: { approvedCapBytes: 32000000, accountingPackageRoots: ["evidence"], accountingWorkspaceRoots: [{ path: "history", required: true }] } });
    const policy = save("accounting.json", { repositoryRoot: root, recordDirectory: "pitchroom-app/.artifacts/workflows", referenceLinks: [], legacyWriters: "quiescent" });
    const launch = save("launch.json", { baseURL, instance: identity, projectId: state.project.id, timeoutMs: 10000, maximumResponseBytes: 1000000 });
    const cli = async (args: string[], expectedCode = 0) => {
      let stdout = "", code = 0;
      try { stdout = (await exec(process.execPath, ["--import", "tsx", "src/task-acceptance/cli.ts", ...args], { cwd: evals, maxBuffer: 4000000, timeout: 20000, env: { NODE_ENV: "production", PATH: process.env.PATH, HOME: process.env.HOME } })).stdout; }
      catch (error) { const failure = z.object({ code: z.number(), stdout: z.string() }).parse(error); code = failure.code; stdout = failure.stdout; }
      expect(code).toBe(expectedCode); return z.object({ result: z.unknown().optional(), errorCode: z.string().optional() }).parse(JSON.parse(stdout));
    };
    const run = z.object({ referenceFile: z.string() }).parse((await cli(["prepare", "--case", resolve(evals, "config/task-acceptance/pitchroom-r1"), "--launch-receipt", launch, "--accounting-policy", policy, "--source-repository", repository, "--session-id", randomUUID(), "--maximum-bytes", "24000000", "--purpose", "tool_validation"])).result);
    const next = async () => gateSchema.parse((await cli(["advance", "--run", run.referenceFile])).result);
    const decision = async (view: z.infer<typeof gateSchema>, response: unknown, expectedCode = 0) => cli(["record-decision", "--run", run.referenceFile, "--file", save(`${randomUUID()}.json`, { decisionId: randomUUID(), actor: "synthetic-operator", at: new Date().toISOString(), checkpointHash: view.checkpointHash, capability: view.capability, assistance: { kind: "none" }, response })], expectedCode);
    let view = await next(); await decision(view, { kind: "not_needed", activity: "clarification", reason: "Synthetic browser review control" });
    view = await next(); await decision(view, { kind: "accept_understanding", versionKey: view.workspace.currentVersionId });
    view = await next(); await decision(view, { kind: "choose_positioning", choiceKey: view.choices[0]?.key });
    view = await next(); await decision(view, { kind: "apply_story", candidateKey: view.choices[0]?.key });
    view = await next(); await decision(view, { kind: "feedback", storyKey: view.workspace.story?.head.storyId, observedCheckpointHash: view.checkpointHash, originalWords: "Preserve unknowns and lead with the pilot decision.", mustChange: ["opening"], mustPreserve: ["unknowns"], mustNot: ["invent outcomes"] });
    view = await next(); await decision(view, { kind: "apply_story", candidateKey: view.choices[0]?.key });
    const firstView = await next();
    const record = async (value: unknown, expectedCode = 0) => cli(["review-record", "--run", run.referenceFile, "--file", save(`${randomUUID()}.json`, value)], expectedCode);
    const authority = { kind: "review_authority", id: "authority", at: new Date().toISOString(), mode: "assisted_self_test", operatorEvidenceRef: "synthetic-browser-test-only", actors: [{ actorId: "synthetic-human-role", personId: "synthetic-person", role: "human", permissions: ["review"] }] };
    await record(authority);
    const calibration = { kind: "review_calibration", id: "calibration", at: new Date().toISOString(), actorId: "synthetic-human-role", authorityHash: hashTaskValue(authority), bankHash: hashTaskValue(calibrationBank), answers: calibrationBank.map(item => ({ caseId: item.id, supportVerdict: item.expected, reason: "Synthetic known answer." })) }; await record(calibration);
    const template = async (checkpoint: string) => templateSchema.parse((await cli(["review-packet", "--run", run.referenceFile, "--checkpoint", checkpoint, "--actor", "synthetic-human-role"])).result);
    const first = await template(firstView.checkpointHash);
    const packet = (value: z.infer<typeof templateSchema>, failed: boolean) => ({ kind: "review_packet", id: randomUUID(), at: new Date().toISOString(), actorId: "synthetic-human-role", authorityHash: hashTaskValue(authority), calibrationHash: hashTaskValue(calibration), binding: value.binding,
      fields: value.fields.filter(field => field.classification === "prose").map(field => ({ kind: "no_factual_claim", pointer: field.pointer, valueHash: field.valueHash, readWholeField: true, reason: "Synthetic review fixture, not real user signoff." })),
      oracle: value.oracle.map((item, index) => ({ oracleId: item.id, verdict: failed && index === 0 ? "violated" : "preserved", fieldPointers: [value.fields[0]?.pointer], reason: "Synthetic controlled disposition." })),
      scores: taskRubric.storyDeck.dimensions.map(dimension => ({ dimension, score: failed ? 0 : 3, reason: "Synthetic rubric control." })), directionDifference: "", assistance: [] });
    const failure = packet(first, true); await record(failure);
    await page.goto("/"); await page.getByRole("button", { name: "Deck", exact: true }).click();
    await page.getByRole("button", { name: "Edit this page" }).click(); await page.getByLabel("Page title").fill("Browser corrected discussion title");
    await page.getByLabel("Page content").fill("Synthetic corrected wording retains uncertainty."); await page.getByRole("button", { name: "Save as new draft" }).click();
    await expect(page.getByRole("heading", { name: "Draft 2" })).toBeVisible();
    expect((await decision(firstView, { kind: "record_review", originalWords: "Stale approval must be refused." }, 1)).errorCode).toBe("WORKFLOW_STALE_DECISION");
    const editedView = await next(), edited = await template(editedView.checkpointHash);
    expect(edited.binding.outputHash).toBe(hashTaskValue(editedView.workspace.deck?.proposal)); expect(edited.binding.outputHash).not.toBe(first.binding.outputHash);
    expect(editedView.workspace.deck?.proposal.pages[0]?.title).toBe("Browser corrected discussion title");
    expect((await record({ ...failure, id: randomUUID(), binding: { ...edited.binding, outputHash: first.binding.outputHash } }, 1)).errorCode).toBe("REVIEW_BINDING_MISMATCH");
    const before = z.object({ attemptHistory: z.array(z.object({ binding: reviewBindingSchema, semantic: z.object({ kind: z.string() }) })) }).parse((await cli(["assess", "--run", run.referenceFile])).result);
    expect(before.attemptHistory.find(item => item.binding.checkpointHash === edited.binding.checkpointHash)?.semantic.kind).toBe("awaiting_review");
    await record(packet(edited, false));
    const reopened = z.object({ attemptHistory: z.array(z.object({ binding: reviewBindingSchema, semantic: z.object({ kind: z.string() }) })), userTask: z.object({ kind: z.string() }) }).parse((await cli(["assess", "--run", run.referenceFile])).result);
    expect(reopened.attemptHistory.find(item => item.binding.checkpointHash === first.binding.checkpointHash)?.semantic.kind).toBe("fail");
    expect(reopened.attemptHistory.find(item => item.binding.checkpointHash === edited.binding.checkpointHash)?.semantic.kind).toBe("pass");
    expect(reopened.userTask.kind).toBe("awaiting_observation");
  } finally {
    await context?.close(); if (server.pid && server.exitCode === null) process.kill(-server.pid, "SIGTERM"); await new Promise<void>(done => { if (server.exitCode !== null) done(); else server.once("exit", () => done()); }); rmSync(root, { recursive: true, force: true });
  }
});
