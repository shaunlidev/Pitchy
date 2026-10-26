import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDedicatedIntegrationTarget } from "./test-persistence.mjs";
const url = "postgres://clarify_qa:synthetic@127.0.0.1:55437/clarify_qa";
test("accepts the existing dedicated QA target and localhost alias", () => {
  assert.equal(isDedicatedIntegrationTarget(url), true);
  assert.equal(isDedicatedIntegrationTarget(url.replace("127.0.0.1", "localhost")), true);
});
test("rejects daily databases, wrong roles, remote targets and connection overrides", () => {
  for (const value of [undefined, "", "not a URL", "postgres://pitchroom:pitchroom@127.0.0.1:54329/pitchroom", url.replace(":55437", ":54329"), url.replace("clarify_qa:", "postgres:"), url.replace("127.0.0.1", "remote.invalid"), url.replace("/clarify_qa", "/pitchroom"), `${url}?options=-csearch_path=private`, `${url}#ignored`, url.replace("postgres:", "https:")]) assert.equal(isDedicatedIntegrationTarget(value), false);
});
test("the CLI refuses an unsafe target without echoing credentials or launching suites", () => {
  const secret = "synthetic-secret-must-not-be-printed";
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./test-persistence.mjs", import.meta.url))], { env: { ...process.env, DATABASE_URL: `postgres://pitchroom:${secret}@127.0.0.1:54329/pitchroom` }, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /No database action was started/);
  assert.doesNotMatch(child.stdout + child.stderr, new RegExp(secret)); assert.doesNotMatch(child.stdout, /RUN|Running.*suites/);
});
test("the CLI fails rather than silently using a local default when DATABASE_URL is absent", () => {
  const env = { ...process.env }; delete env.DATABASE_URL;
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./test-persistence.mjs", import.meta.url))], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /set DATABASE_URL explicitly/);
});
