import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

// Keep startup independent of the application and TypeScript loader. The parent
// verifies this canonical hash against hashTaskValue for every observed event.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}
function hashTaskValue(value) {
  const serialized = JSON.stringify(canonicalize(value));
  assert.notEqual(serialized, undefined);
  return createHash("sha256").update(serialized).digest("hex");
}
function assertUnlinkedPath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { assert(!lstatSync(current).isSymbolicLink(), "EVIDENCE_PATH_SYMLINK"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(current) === current) break;
  }
}
function byteCount(path) {
  return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    assert(!entry.isSymbolicLink(), "Evidence symlink refused");
    const child = join(path, entry.name);
    return sum + (entry.isDirectory() ? byteCount(child) : statSync(child).size);
  }, 0);
}

const allowed = new URL(process.env.PIT56_CHILD_NETWORK_GUARD);
assert.equal(allowed.hostname, "127.0.0.1");
assert.equal(process.env.PITCHROOM_RUNTIME, "postgres-fake");
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.PITCHROOM_LIVE_TRANSFER_ACK, undefined);
const directory = process.env.PIT56_CHILD_GUARD_DIRECTORY;
assert(typeof directory === "string" && isAbsolute(directory), "PIT56_CHILD_GUARD_DIRECTORY_INVALID");
const nonce = process.env.PIT56_CHILD_GUARD_NONCE;
assert(typeof nonce === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce), "PIT56_CHILD_GUARD_NONCE_INVALID");
const sourceHash = process.env.PITCHROOM_EVAL_SOURCE_HASH;
assert(typeof sourceHash === "string" && /^[a-f0-9]{64}$/.test(sourceHash), "PIT56_CHILD_SOURCE_HASH_INVALID");
assertUnlinkedPath(directory);
assert(readdirSync(directory).length < 64, "Child guard process limit exceeded");
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
