import { resolve } from "node:path";
import { orchestrateUnderstandingRun, type AgentAction, type StepAgent } from "@pitchroom/agent";
import { ingestMaterial, replayTerminalPhase, type AgentEvent, type SourceChunk, type SourceRecord, type ToolRepository, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { writeRunArtifactBundle } from "@pitchroom/testkit";
import { gradeProposal, initialEvalCases } from "./index.ts";

const caseId = process.argv.slice(2).find((argument) => argument !== "--");
if (!caseId) throw new Error("Usage: pnpm harness:case -- <case-id>");
const evalCase = initialEvalCases.find((candidate) => candidate.id === caseId);
if (!evalCase) throw new Error(`Unknown eval case: ${caseId}`);

const projectId = "eval-project";
const runId = `eval-${caseId}`;
const materials = evalCase.sourceTexts.map((text, index) => ingestMaterial(projectId, { name: `source-${index + 1}.txt`, mediaType: "text/plain", text }));
const sources: SourceRecord[] = materials.map((material) => ({ id: material.sourceId, projectId, name: material.name, mediaType: material.mediaType, contentHash: material.contentHash, chunks: material.chunks }));
const chunks = sources.flatMap((source) => source.chunks);
const timestamp = new Date().toISOString();

function containingChunk(phrase?: string) {
  return chunks.find((chunk) => phrase && chunk.text.toLocaleLowerCase("en-US").includes(phrase.toLocaleLowerCase("en-US"))) ?? chunks[0]!;
}

function excerpt(chunk: SourceChunk, preferred?: string) {
  if (preferred) {
    const start = chunk.text.toLocaleLowerCase("en-US").indexOf(preferred.toLocaleLowerCase("en-US"));
    if (start >= 0) return chunk.text.slice(start, start + preferred.length);
  }
  return chunk.text.trim().slice(0, Math.min(chunk.text.trim().length, 120));
}

const state = evalCase.expectedEvidenceStates[0] ?? "unknown";
const required = evalCase.requiredPhrases[0];
const primary = containingChunk(required);
const evidence = state === "supported"
  ? [{ sourceId: primary.sourceId, chunkId: primary.id, quote: excerpt(primary, required) }]
  : state === "conflicting"
    ? sources.slice(0, 2).map((source) => ({ sourceId: source.id, chunkId: source.chunks[0]!.id, quote: excerpt(source.chunks[0]!) }))
    : [];
const statement = required ?? (state === "unknown" ? "The requested fact remains unknown from the supplied material." : evidence.map((item) => item.quote).join(" / "));
const proposal: UnderstandingProposalV1 = {
  schemaVersion: 1,
  themes: [{ title: "Harness result", summary: evalCase.annotation, claims: [{ statement, evidenceState: state, evidence, userInputIds: state === "user_asserted" ? ["eval-user-input"] : [] }] }],
  gaps: state === "unknown" ? [{ description: "Required information is missing.", whyItMatters: evalCase.annotation, relatedSourceIds: materials.map((material) => material.sourceId) }] : [],
  nextQuestion: { question: "What evidence would resolve the most important uncertainty?", whyItMatters: "It determines the next grounded update.", relatedThemeIndexes: [0] },
};

let firstTransientRead = evalCase.category === "tool_failure";
const repository: ToolRepository = {
  async listSources(requestProjectId) { return requestProjectId === projectId ? sources : []; },
  async getSource(requestProjectId, sourceId) { return requestProjectId === projectId ? sources.find((source) => source.id === sourceId) : undefined; },
  async getChunk(requestProjectId, chunkId) {
    if (requestProjectId !== projectId) return undefined;
    if (firstTransientRead) { firstTransientRead = false; throw new Error("transient read failure"); }
    return chunks.find((chunk) => chunk.id === chunkId);
  },
};

let events: AgentEvent[];
let terminalProposal = proposal;
let stepCount: number;

if (state === "user_asserted") {
  events = [
    { runId, sequence: 1, type: "run_started", timestamp, payload: { caseId } },
    { runId, sequence: 2, type: "phase_changed", timestamp, payload: { to: "review_required" } },
    { runId, sequence: 3, type: "user_input_recorded", timestamp, payload: { userInputId: "eval-user-input", kind: "correction" } },
    { runId, sequence: 4, type: "version_created", timestamp, payload: { createdBy: "user" } },
  ];
  stepCount = 0;
} else {
  const reads = state === "conflicting" ? sources.slice(0, 2).map((source) => source.chunks[0]!) : [primary];
  const actions: AgentAction[] = [
    { type: "tool", call: { name: "list_sources", arguments: {} } },
    { type: "tool", call: { name: "list_chunks", arguments: { sourceId: reads[0]!.sourceId, cursor: 0 } } },
    ...reads.flatMap((chunk, index) => {
      const read: AgentAction = { type: "tool", call: { name: "read_chunk", arguments: { chunkId: chunk.id } } };
      return evalCase.category === "tool_failure" && index === 0 ? [read, read] : [read];
    }),
    { type: "submit", proposal, publicSummary: evalCase.annotation },
  ];
  const agent: StepAgent = { async next({ step }) { return actions[step - 1] ?? actions.at(-1)!; } };
  const result = await orchestrateUnderstandingRun({ runId, projectId, currentPhase: "materials_ready", repository, agent, now: () => timestamp, budgets: { maxSteps: 8, maxRepeatedCall: 2, maxConsecutiveToolFailures: 3 } });
  events = result.events;
  terminalProposal = result.proposal;
  stepCount = Number([...result.events].reverse().find((event: AgentEvent) => event.type === "run_completed")?.payload.step ?? actions.length);
}

const terminalPhase = replayTerminalPhase(events) ?? "review_required";
const grade = gradeProposal({ evalCase, proposal: terminalProposal, chunks, terminalPhase, stepCount, maxSteps: 8 });
const target = await writeRunArtifactBundle({ root: resolve(".artifacts/agent-runs"), manifest: { runId, mode: "offline-eval", codeVersion: "working-tree", schemaVersion: 1, promptVersion: "scripted-tool-harness-v2", model: "scripted-step-agent", startedAt: timestamp }, inputs: { caseId, sourceHashes: materials.map((material) => material.contentHash) }, events, proposal: terminalProposal, outcome: { phase: terminalPhase, passed: grade.passed }, scores: grade });
console.log(JSON.stringify({ runId, caseId, passed: grade.passed, artifact: target, eventCount: events.length, toolCalls: events.filter((event) => event.type === "tool_called").length, failedChecks: grade.checks.filter((check) => !check.passed) }, null, 2));
if (!grade.passed) process.exitCode = 1;
