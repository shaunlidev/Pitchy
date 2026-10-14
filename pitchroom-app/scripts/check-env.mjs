const runtime = process.env.PITCHROOM_RUNTIME ?? "fixture";
const allowed = new Set(["fixture", "postgres-fake", "live"]);
if (!allowed.has(runtime)) {
  console.error(`INVALID_INPUT: PITCHROOM_RUNTIME must be one of ${[...allowed].join(", ")}.`);
  process.exit(1);
}
const missing = [];
if (runtime !== "fixture" && !process.env.DATABASE_URL) missing.push("DATABASE_URL");
if (runtime === "live" && !process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
if (runtime === "live" && !process.env.OPENAI_MODEL) missing.push("OPENAI_MODEL");
if (runtime === "live" && process.env.PITCHROOM_LIVE_TRANSFER_ACK !== "authorized") missing.push("PITCHROOM_LIVE_TRANSFER_ACK=authorized");
if (missing.length > 0) {
  console.error(`INVALID_INPUT: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required for ${runtime} mode.`);
  process.exit(1);
}
console.log(JSON.stringify({ status: "PASS", runtime, externalModelEnabled: runtime === "live" }));
