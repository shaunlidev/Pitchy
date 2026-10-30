// Test-only isolated workflow fixtures; never imported by production modules.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";
import { z } from "zod";
import { workspaceStateSchema } from "@pitchroom/domain";
import { GET, POST } from "../../../../apps/web/app/api/workspace/route";
import { healthResponse } from "../../../../apps/web/app/api/health/route";
import { evaluationInstance } from "../../../../apps/web/lib/evaluation-instance";
import { resetFixtureState } from "../../../../apps/web/lib/fixture-store";
import { advance, prepare, recordDecision } from "./workflow";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
export function fixture() {
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
export async function httpFixture(fullTask = false, afterPost?: () => Promise<void>) {
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

export const humanViewSchema = z.object({ kind: z.literal("awaiting_human"), step: z.string(), checkpointHash: z.string(), capability: z.string(), workspace: workspaceStateSchema, choices: z.array(z.object({ key: z.string() })) });
export function humanDecision(view: z.infer<typeof humanViewSchema>, response: unknown) {
  return { decisionId: randomUUID(), actor: "synthetic-operator", at: new Date().toISOString(), checkpointHash: view.checkpointHash, capability: view.capability, assistance: { kind: "none" }, response };
}
export async function reachDeck(run: ReturnType<typeof prepare>) {
  let view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: humanDecision(view, { kind: "not_needed", activity: "clarification", reason: "Synthetic uncovered branch." }) });
  view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: humanDecision(view, { kind: "accept_understanding", versionKey: view.workspace.currentVersionId }) });
  view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: humanDecision(view, { kind: "choose_positioning", choiceKey: view.choices[0]?.key }) });
  view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: humanDecision(view, { kind: "apply_story", candidateKey: view.choices[0]?.key }) });
  view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: humanDecision(view, { kind: "feedback", storyKey: view.workspace.story?.head.storyId, observedCheckpointHash: view.checkpointHash,
    originalWords: "Keep the unknowns explicit and lead with a bounded pilot decision.", mustChange: ["opening"], mustPreserve: ["unknowns"], mustNot: ["invent outcomes"] }) });
  view = humanViewSchema.parse(await advance(run));
  await recordDecision({ run, decision: humanDecision(view, { kind: "apply_story", candidateKey: view.choices[0]?.key }) });
  return humanViewSchema.parse(await advance(run));
}
