import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { agentEventSchema, replayTerminalPhase } from "@pitchroom/domain";

const runId = process.argv.slice(2).find((argument) => argument !== "--");
if (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Usage: pnpm harness:replay -- <safe-run-id>");
const root = resolve(".artifacts/agent-runs", runId);
const lines = (await readFile(resolve(root, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean);
const events = lines.map((line) => agentEventSchema.parse(JSON.parse(line)));
for (const [index, event] of events.entries()) {
  if (event.sequence !== index + 1) throw new Error(`Event sequence gap at ${event.sequence}; expected ${index + 1}.`);
}
const outcome = JSON.parse(await readFile(resolve(root, "outcome.json"), "utf8")) as { phase?: string };
const replayedPhase = replayTerminalPhase(events);
if (outcome.phase !== replayedPhase) throw new Error(`Replay mismatch: stored=${outcome.phase} replayed=${replayedPhase}.`);
console.log(JSON.stringify({ status: "PASS", runId, events: events.length, replayedPhase }, null, 2));
