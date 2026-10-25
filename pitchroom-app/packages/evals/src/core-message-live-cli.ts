import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CoreMessageLiveStop, prepareCoreMessageLiveSession, reprocessCoreMessageCandidate, resolveSession, runCoreMessageLiveSession, verifyCoreMessageReview } from "./core-message-live";

const args = process.argv.slice(2);
const value = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
async function main() {
  const modes = ["--prepare", "--run", "--status", "--verify-review", "--reprocess-candidate"].filter((flag) => args.includes(flag));
  if (modes.length !== 1) { process.stdout.write("Core-message live eval: --prepare --config FILE [--fixture FILE] --session NEW_DIR | --run --session DIR --authorize-synthetic-transfer | --status --session DIR | --verify-review --session DIR | --reprocess-candidate --source-session DIR --session NEW_DIR\nDefault: zero network calls. No .env files are loaded.\n"); return; }
  const sessionArg = value("--session");
  if (!sessionArg) throw new CoreMessageLiveStop("SESSION_REQUIRED");
  const root = resolveSession(sessionArg);
  if (modes[0] === "--reprocess-candidate") {
    const source = value("--source-session"); if (!source) throw new CoreMessageLiveStop("SOURCE_SESSION_REQUIRED");
    process.stdout.write(`${JSON.stringify(reprocessCoreMessageCandidate(resolveSession(source), root))}\n`); return;
  }
  if (modes[0] === "--prepare") {
    const config = value("--config"); if (!config) throw new CoreMessageLiveStop("CONFIG_REQUIRED");
    const fixture = value("--fixture");
    process.stdout.write(`${JSON.stringify(prepareCoreMessageLiveSession(root, JSON.parse(readFileSync(config, "utf8")), fixture ? JSON.parse(readFileSync(fixture, "utf8")) : undefined))}\n`); return;
  }
  if (modes[0] === "--status") { process.stdout.write(readFileSync(join(root, "manifest.json"), "utf8")); return; }
  if (modes[0] === "--verify-review") { process.stdout.write(`${JSON.stringify(verifyCoreMessageReview(root))}\n`); return; }
  if (!args.includes("--authorize-synthetic-transfer") || process.env.PITCHROOM_CORE_MESSAGE_LIVE_TRANSFER_ACK !== "authorized") throw new CoreMessageLiveStop("EXPLICIT_LIVE_AUTHORIZATION_REQUIRED");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as { config?: { provider?: string } };
  // The app exposes OpenAI-compatible providers through OPENAI_API_KEY;
  // DEEPSEEK_API_KEY remains an optional provider-specific override.
  const apiKey = manifest.config?.provider === "deepseek" ? (process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY) : process.env.OPENAI_API_KEY;
  if (!apiKey) throw new CoreMessageLiveStop("API_KEY_REQUIRED");
  process.stdout.write(`${JSON.stringify(await runCoreMessageLiveSession(root, apiKey))}\n`);
}
main().catch((error) => { process.stderr.write(`${error instanceof CoreMessageLiveStop ? error.code : "CONFIGURATION_OR_LOCAL_IO_ERROR"}\n`); process.exitCode = 1; });
