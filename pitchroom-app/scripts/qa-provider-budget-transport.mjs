import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Test entrypoint only: no production configuration can install this transport.
const root = process.env.PIT55_SYNTHETIC_ROOT;
assert(root && process.env.OPENAI_API_KEY === "test");
const endpoint = "https://pit55-synthetic.deepseek.com/responses";
assert.equal(process.env.OPENAI_BASE_URL, "https://pit55-synthetic.deepseek.com");
const originalFetch = globalThis.fetch;
const digest = value => createHash("sha256").update(value).digest("hex");
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href !== endpoint) {
    assert.equal(url.origin, process.env.PIT55_LOOPBACK_ORIGIN, "Unexpected network destination in synthetic QA");
    return originalFetch(input, init);
  }
  assert.equal(init?.method, "POST");
  assert.equal(typeof init.body, "string");
  for (const forbidden of ["ORACLE_PIT55_PRIVATE", "REVIEWER_PIT55_PRIVATE", "Bearer test"]) assert(!init.body.includes(forbidden), "Forbidden test literal entered provider body");
  const reference = JSON.parse(readFileSync(process.env.PITCHROOM_EVAL_BUDGET_FILE, "utf8"));
  const entries = readFileSync(join(reference.directory, "provider.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const last = entries.at(-1);
  assert.equal(last.event.kind, "reserved", "Provider called without prior durable reservation");
  assert.equal(last.event.reservation.requestHash, digest(init.body));
  const fixture = JSON.parse(readFileSync(join(root, "response-fixture.json"), "utf8"));
  const body = JSON.parse(init.body), stage = last.event.reservation.stage;
  const capture = join(root, "transport.jsonl");
  const line = JSON.stringify({ pid: process.pid, stage, callId: last.event.reservation.callId,
    commandId: last.event.reservation.commandId, requestHash: last.event.reservation.requestHash,
    reservationEntryHash: last.hash, transport: "synthetic_injected", forbiddenLiteralsAbsent: true }) + "\n";
  let previousBytes = 0;
  try { previousBytes = statSync(capture).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
  assert(previousBytes + Buffer.byteLength(line) <= 16_000, "Synthetic transport evidence cap exceeded");
  appendFileSync(capture, line, { mode: 0o600 });
  if (stage === "understanding" && fixture.delayMs) await new Promise(resolve => setTimeout(resolve, fixture.delayMs));
  let output;
  if (stage === "understanding") {
    const readback = body.input.find(item => item.type === "function_call_output" && item.call_id === "pit55-read");
    if (!readback) output = [{ type: "function_call", id: "fc-pit55", call_id: "pit55-read", name: "read_chunk", arguments: JSON.stringify({ chunkId: fixture.chunk.id }) }];
    else {
      assert(readback.output.includes(fixture.chunk.text), "Actual source tool did not return the synthetic passage");
      output = message(fixture.understanding);
    }
  } else {
    assert.equal(stage, "clarify", "Unexpected model stage in bounded synthetic scenario");
    output = message(fixture.mode === "invalid-draft" ? { invalidSyntheticDraft: true } : fixture.clarify);
  }
  return new Response(JSON.stringify({ id: `resp-${randomUUID()}`, model: "synthetic-model", status: "completed", error: null,
    ...(fixture.mode === "missing-usage" ? {} : { usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 } }), output }),
  { headers: { "content-type": "application/json" } });
};
function message(value) {
  return [{ type: "message", id: `msg-${randomUUID()}`, role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }];
}
const readiness = JSON.stringify({ pid: process.pid, endpoint, transport: "synthetic_injected" });
const readinessBytes = readdirSync(root).filter(name => name.startsWith("preload-")).reduce((sum, name) => sum + statSync(join(root, name)).size, 0);
assert(readinessBytes + Buffer.byteLength(readiness) <= 4000, "Preload identity allowance exceeded");
writeFileSync(join(root, `preload-${process.pid}.json`), readiness, { flag: "wx", mode: 0o600 });
