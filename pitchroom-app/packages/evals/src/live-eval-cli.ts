import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createLiveUnderstandingRunner, runUnderstandingAgent } from "@pitchroom/agent";
import { ingestMaterial, type SourceRecord, type ToolRepository } from "@pitchroom/domain";
import { writeRunArtifactBundle } from "@pitchroom/testkit";
import { gradeProposal, initialEvalCases } from "./index.ts";
import { selectLiveEvalCases } from "./live-eval.ts";

const mode = process.argv.includes("--all") ? "all" : "smoke";
if (process.env.PITCHROOM_LIVE_EVAL_ACK !== "synthetic-only") throw new Error("Set PITCHROOM_LIVE_EVAL_ACK=synthetic-only to acknowledge external transfer of synthetic eval material.");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required for live eval.");
if (!process.env.OPENAI_MODEL) throw new Error("OPENAI_MODEL must be pinned for live eval.");

const selected = selectLiveEvalCases(initialEvalCases, mode);
const batchId = `live-${mode}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
const root = resolve(".artifacts/live-evals", batchId);
await mkdir(root, { recursive: true });
const results: Array<{ id: string; passed: boolean; latencyMs: number; failures: string[] }> = [];

for (const evalCase of selected) {
  const projectId = `live-eval-${evalCase.id}`;
  const materials = evalCase.sourceTexts.map((text, index) => ingestMaterial(projectId, { name: `source-${index + 1}.txt`, mediaType: "text/plain", text }));
  const sources: SourceRecord[] = materials.map((material) => ({ id: material.sourceId, projectId, name: material.name, mediaType: material.mediaType, contentHash: material.contentHash, chunks: material.chunks }));
  const repository: ToolRepository = {
    async listSources(requestProjectId) { return requestProjectId === projectId ? sources : []; },
    async getSource(requestProjectId, sourceId) { return requestProjectId === projectId ? sources.find((source) => source.id === sourceId) : undefined; },
    async getChunk(requestProjectId, chunkId) { return requestProjectId === projectId ? sources.flatMap((source) => source.chunks).find((chunk) => chunk.id === chunkId) : undefined; },
  };
  const runner = createLiveUnderstandingRunner(repository, { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, baseURL: process.env.OPENAI_BASE_URL });
  const startedAt = new Date();
  const outcome = await runUnderstandingAgent("materials_ready", { projectId, chunks: sources.flatMap((source) => source.chunks) }, runner);
  const latencyMs = Date.now() - startedAt.getTime();
  const grade = gradeProposal({ evalCase, proposal: outcome.proposal, chunks: sources.flatMap((source) => source.chunks), terminalPhase: outcome.phase, stepCount: Number(outcome.metrics?.stepCount ?? 8), maxSteps: 8 });
  const runId = `${batchId}-${evalCase.id}`;
  await writeRunArtifactBundle({ root, manifest: { runId, mode: "live-model", codeVersion: "working-tree", schemaVersion: 1, promptVersion: "understanding-live-v1", model: process.env.OPENAI_MODEL, startedAt: startedAt.toISOString() }, inputs: { caseId: evalCase.id, sourceHashes: materials.map((material) => material.contentHash) }, events: outcome.trace.map((event, index) => ({ runId, sequence: index + 1, type: event.type, timestamp: startedAt.toISOString(), payload: event.payload })), proposal: outcome.proposal, outcome: { phase: outcome.phase, latencyMs, metrics: outcome.metrics }, scores: grade });
  results.push({ id: evalCase.id, passed: grade.passed, latencyMs, failures: grade.checks.filter((check) => !check.passed).map((check) => check.name) });
  if (!grade.passed && evalCase.critical) break;
}

const report = { batchId, mode, model: process.env.OPENAI_MODEL, attempted: results.length, selected: selected.length, passed: results.filter((item) => item.passed).length, stoppedOnCriticalFailure: results.length < selected.length, results };
await writeFile(resolve(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (results.length !== selected.length || results.some((item) => !item.passed)) process.exitCode = 1;
