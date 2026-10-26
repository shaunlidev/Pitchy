import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactSecrets, writeRunArtifactBundle } from "./artifacts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("run artifacts", () => {
  it("redacts nested secrets", () => expect(redactSecrets({ token: "x", nested: { apiKey: "y", okay: 3 } })).toEqual({ token: "[REDACTED]", nested: { apiKey: "[REDACTED]", okay: 3 } }));
  it("writes a complete atomic bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitchroom-artifacts-")); roots.push(root);
    const target = await writeRunArtifactBundle({ root, manifest: { runId: "run_1", mode: "fake", codeVersion: "test", schemaVersion: 1, promptVersion: "v1", model: "fake", startedAt: "2026-10-14T00:00:00.000Z" }, inputs: { authorization: "secret" }, events: [{ type: "run_started" }], outcome: { phase: "review_required" } });
    expect(JSON.parse(await readFile(join(target, "inputs.json"), "utf8"))).toEqual({ authorization: "[REDACTED]" });
    expect(await readFile(join(target, "events.jsonl"), "utf8")).toContain("run_started");
  });
  it("rejects traversal in run ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "pitchroom-artifacts-")); roots.push(root);
    await expect(writeRunArtifactBundle({ root, manifest: { runId: "../escape", mode: "fake", codeVersion: "test", schemaVersion: 1, promptVersion: "v1", model: "fake", startedAt: "2026-10-14T00:00:00.000Z" }, inputs: {}, events: [], outcome: {} })).rejects.toThrow("unsafe path");
  });
});
