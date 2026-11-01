import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { fixture } from "./review-fixture";
import { advance, prepare, taskAcceptanceSourcePaths } from "./workflow";
it("refuses budget and transport source changes before any workflow HTTP dispatch", async () => {
  const f = fixture(), source = join(f.root, "source"), network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  mkdirSync(source);
  const paths = [...taskAcceptanceSourcePaths, "pitchroom-app/pnpm-lock.yaml"];
  for (const path of paths) { const destination = join(source, path); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, readFileSync(join(f.input.sourceRepository, path))); }
  execFileSync("git", ["init", "--quiet"], { cwd: source }); execFileSync("git", ["add", "."], { cwd: source });
  execFileSync("git", ["-c", "user.name=Synthetic test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "Synthetic frozen sources"], { cwd: source });
  const run = prepare({ ...f.input, sourceRepository: source });
  for (const path of ["packages/agent/src/provider-budget.ts", "packages/agent/src/evaluation-provider.ts", "apps/web/lib/persistent-workspace.ts", "apps/web/lib/story-service.ts", "scripts/clarification-worker.ts", "packages/evals/src/task-acceptance/provider-budget-audit.ts"]) {
    const target = join(source, "pitchroom-app", path), before = readFileSync(target, "utf8"); writeFileSync(target, before + "\n// Synthetic changed source\n");
    await expect(advance(run), path).rejects.toThrow("WORKFLOW_CODE_CHANGED"); writeFileSync(target, before);
  }
  expect(network).not.toHaveBeenCalled();
});
