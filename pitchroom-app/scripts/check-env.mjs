import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const localEnvPath = resolve(process.cwd(), "apps/web/.env.local");
if (existsSync(localEnvPath)) {
  for (const rawLine of readFileSync(localEnvPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] ??= value;
  }
}

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
