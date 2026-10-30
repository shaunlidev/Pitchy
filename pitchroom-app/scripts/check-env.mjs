import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRuntimeConfiguration, configurationSummary } from "../packages/domain/src/runtime-configuration.ts";

const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => !["--production", "--worker", "--live"].includes(flag)) || (flags.has("--live") && !flags.has("--worker"))) {
  process.stderr.write("INVALID_CONFIGURATION: unsupported configuration-check option.\n");
  process.exit(1);
}
const environment = { ...process.env, ...(flags.has("--production") ? { NODE_ENV: "production" } : {}) };

const localEnvPath = resolve(process.cwd(), "apps/web/.env.local");
const localFilesAllowed = environment.NODE_ENV !== "production" && [undefined, "local"].includes(environment.PITCHROOM_DEPLOYMENT_ENV);
if (localFilesAllowed && existsSync(localEnvPath)) {
  for (const rawLine of readFileSync(localEnvPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if ((key === "PITCHROOM_DEPLOYMENT_ENV" && value !== "local") || (key === "NODE_ENV" && value === "production")) {
      process.stderr.write("INVALID_CONFIGURATION: deployment identity must be supplied by the process environment.\n");
      process.exit(1);
    }
    environment[key] ??= value;
  }
}

const result = parseRuntimeConfiguration(environment, { component: flags.has("--worker") ? "worker" : "web", liveFlag: flags.has("--live") });
if (!result.success) {
  process.stderr.write(`INVALID_CONFIGURATION: ${result.fields.join(", ")}.\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ status: "CONFIGURATION_VALID", ...configurationSummary(result.config) })}\n`);
