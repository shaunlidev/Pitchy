import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { z } from "zod";

export const runManifestSchema = z.object({
  runId: z.string().min(1),
  mode: z.enum(["fake", "offline-eval", "live-model"]),
  codeVersion: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  promptVersion: z.string().min(1),
  model: z.string().min(1),
  startedAt: z.string().datetime(),
});

const secretKey = /authorization|api[-_]?key|secret|token|password/i;
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, secretKey.test(key) ? "[REDACTED]" : redactSecrets(child)]));
  }
  return value;
}

function safeTarget(root: string, runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Run ID contains unsafe path characters.");
  const target = resolve(root, runId);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Artifact target escapes the artifact root.");
  return normalize(target);
}

export async function writeRunArtifactBundle(input: {
  root: string;
  manifest: z.infer<typeof runManifestSchema>;
  inputs: unknown;
  events: unknown[];
  proposal?: unknown;
  outcome: unknown;
  scores?: unknown;
}) {
  const manifest = runManifestSchema.parse(input.manifest);
  const target = safeTarget(input.root, manifest.runId);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(temporary, { recursive: true });
  const writeJson = (name: string, value: unknown) => writeFile(join(temporary, name), `${JSON.stringify(redactSecrets(value), null, 2)}\n`, "utf8");
  await Promise.all([
    writeJson("manifest.json", manifest), writeJson("inputs.json", input.inputs),
    writeFile(join(temporary, "events.jsonl"), `${input.events.map((event) => JSON.stringify(redactSecrets(event))).join("\n")}\n`, "utf8"),
    writeJson("outcome.json", input.outcome),
    input.proposal === undefined ? Promise.resolve() : writeJson("proposal.json", input.proposal),
    input.scores === undefined ? Promise.resolve() : writeJson("scores.json", input.scores),
  ]);
  await rm(target, { recursive: true, force: true });
  await rename(temporary, target);
  return target;
}
