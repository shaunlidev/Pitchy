import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectEvidenceCapacity, loadEvidencePolicy, recoverEvidenceLock, reserveEvidenceWrite, withEvidenceLock } from "./capacity";

const roots: string[] = [];
function fixture(cap = 1_000_000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit51-capacity-"))); roots.push(root);
  for (const path of ["pitchroom-v6/evidence", "history", "pitchroom-app/.artifacts", "pitchroom-app/node_modules"]) mkdirSync(join(root, path), { recursive: true });
  const manifest = join(root, "pitchroom-v6/manifest.json");
  const data = { evidencePolicy: { approvedCapBytes: cap, accountingPackageRoots: ["evidence"], accountingWorkspaceRoots: [{ path: "history", required: true }, { path: "optional", required: false }, { path: "pitchroom-app/.artifacts", required: true }] } };
  writeFileSync(manifest, JSON.stringify(data));
  const input = { repositoryRoot: root, recordDirectory: "pitchroom-app/.artifacts/task-sessions", referenceLinks: [], legacyWriters: "quiescent" };
  return { root, manifest, data, input, policy: loadEvidencePolicy(input) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("PIT-51 metadata capacity and cross-process lock contract", () => {
  it("counts package/history/app roots once and includes optional roots appearing later", () => {
    const f = fixture();
    writeFileSync(join(f.root, "history/old.json"), "1234567");
    writeFileSync(join(f.root, "pitchroom-app/.artifacts/old.json"), "12345");
    expect(inspectEvidenceCapacity(f.policy).usedBytes).toBe(12);
    mkdirSync(join(f.root, "optional")); writeFileSync(join(f.root, "optional/new.json"), "123");
    expect(inspectEvidenceCapacity(f.policy).usedBytes).toBe(15);
  });

  it("fails closed for missing historical roots or an edited policy", () => {
    const f = fixture(); rmSync(join(f.root, "history"), { recursive: true });
    expect(() => inspectEvidenceCapacity(f.policy)).toThrow("MISSING_EVIDENCE_ROOT");
    expect(() => loadEvidencePolicy(f.input)).toThrow("MISSING_EVIDENCE_ROOT");
    mkdirSync(join(f.root, "history"));
    f.data.evidencePolicy.approvedCapBytes -= 1; writeFileSync(f.manifest, JSON.stringify(f.data));
    expect(() => inspectEvidenceCapacity(f.policy)).toThrow("EVIDENCE_POLICY_CHANGED");
  });

  it("never accepts a cap above the owner-approved 320MB or an unaccounted output path", () => {
    const f = fixture(); f.data.evidencePolicy.approvedCapBytes = 320_000_001; writeFileSync(f.manifest, JSON.stringify(f.data));
    expect(() => loadEvidencePolicy(f.input)).toThrow();
    const g = fixture();
    for (const recordDirectory of ["elsewhere", "../escape", "pitchroom-app/.artifacts"]) expect(() => loadEvidencePolicy({ ...g.input, recordDirectory })).toThrow();
  });

  it("rejects unknown links and validates exact dependency reference receipts", () => {
    const f = fixture();
    const link = join(f.root, "pitchroom-app/.artifacts/node_modules"), target = join(f.root, "pitchroom-app/node_modules");
    writeFileSync(join(target, "dependency-file"), "not a recorded QA artifact"); symlinkSync(target, link, "dir");
    expect(() => inspectEvidenceCapacity(f.policy)).toThrow("UNCLASSIFIED_OR_CHANGED_EVIDENCE_LINK");
    const receipt = { path: "pitchroom-app/.artifacts/node_modules", linkText: readlinkSync(link), target: realpathSync(target), category: "dependency_reference", evidenceRef: "synthetic installed dependency receipt" };
    const policy = loadEvidencePolicy({ ...f.input, referenceLinks: [receipt] });
    expect(inspectEvidenceCapacity(policy)).toMatchObject({ classifiedLinks: 1, usedBytes: Buffer.byteLength(target) });
    unlinkSync(link); symlinkSync(join(f.root, "history"), link, "dir");
    expect(() => inspectEvidenceCapacity(policy)).toThrow("UNCLASSIFIED_OR_CHANGED_EVIDENCE_LINK");
  });

  it("recognizes exact installed workspace dependency references but refuses unrelated target directories", () => {
    const f = fixture(), target = join(f.root, "pitchroom-app/packages/evals/node_modules/@types");
    mkdirSync(target, { recursive: true }); writeFileSync(join(f.root, "pitchroom-app/packages/evals/package.json"), '{"name":"synthetic-evals"}');
    const path = "pitchroom-app/.artifacts/node_modules", link = join(f.root, path); symlinkSync(target, link, "dir");
    const receipt = { path, linkText: readlinkSync(link), target: realpathSync(target), category: "dependency_reference", evidenceRef: "synthetic workspace dependency" };
    expect(inspectEvidenceCapacity(loadEvidencePolicy({ ...f.input, referenceLinks: [receipt] })).classifiedLinks).toBe(1);
    unlinkSync(link); const other = join(f.root, "unclassified-data"); mkdirSync(other); symlinkSync(other, link, "dir");
    expect(() => inspectEvidenceCapacity(loadEvidencePolicy({ ...f.input, referenceLinks: [{ ...receipt, linkText: other, target: other }] }))).toThrow("INVALID_DEPENDENCY_REFERENCE");
  });

  it("counts an explicit temporary build-cache link without excluding arbitrary QA references", () => {
    const f = fixture(), cache = join(f.root, "compiler-cache"); mkdirSync(cache);
    writeFileSync(join(cache, "compiled.js"), "compiled output outside evidence roots");
    const path = "pitchroom-app/.artifacts/.next-qa", link = join(f.root, path); symlinkSync(cache, link, "dir");
    const receipt = { path, linkText: readlinkSync(link), target: cache, category: "build_cache_reference", evidenceRef: "synthetic build output, not diagnostics" };
    const policy = loadEvidencePolicy({ ...f.input, referenceLinks: [receipt] });
    expect(inspectEvidenceCapacity(policy).usedBytes).toBe(Buffer.byteLength(cache));
    expect(() => inspectEvidenceCapacity(loadEvidencePolicy({ ...f.input, referenceLinks: [{ ...receipt, category: "dependency_reference" }] }))).toThrow("INVALID_DEPENDENCY_REFERENCE");
    unlinkSync(link);
    expect(() => inspectEvidenceCapacity(policy)).toThrow("STALE_REFERENCE_RECEIPT");
  });

  it("requires legacy writers to be quiescent and refuses insufficient capacity before writes", () => {
    const f = fixture(100);
    expect(() => withEvidenceLock(f.policy, () => 1)).toThrow("EVIDENCE_CAPACITY");
    const g = fixture();
    expect(() => withEvidenceLock(loadEvidencePolicy({ ...g.input, legacyWriters: "not_verified" }), () => 1)).toThrow("LEGACY_WRITERS_NOT_QUIESCENT");
    expect(() => reserveEvidenceWrite(g.policy, { sessionRoot: join(g.policy.recordRoot, "new"), maximumSessionBytes: 10, additionalBytes: 11 })).toThrow("EVIDENCE_CAPACITY");
  });

  it("permits one synchronous writer, rejects overlapping writers and never reclaims a live owner", () => {
    const f = fixture();
    const result = withEvidenceLock(f.policy, () => {
      expect(() => withEvidenceLock(f.policy, () => 2)).toThrow("EVIDENCE_LOCKED");
      const owner = JSON.parse(readFileSync(join(f.policy.recordRoot, ".write-lock/owner.json"), "utf8"));
      expect(() => recoverEvidenceLock(f.policy, owner.token)).toThrow("LOCK_OWNER_ALIVE");
      return 1;
    });
    expect(result).toBe(1);
    expect(withEvidenceLock(f.policy, () => 3)).toBe(3);
    if (false) {
      // @ts-expect-error Transactions cannot accept async callbacks that outlive their lock.
      withEvidenceLock(f.policy, async () => 1);
    }
  });

  it("requires an exact local owner token for crash recovery; incomplete ownership stops", () => {
    const f = fixture(); mkdirSync(f.policy.recordRoot, { mode: 0o700 });
    const lock = join(f.policy.recordRoot, ".write-lock"); mkdirSync(lock, { mode: 0o700 });
    expect(() => recoverEvidenceLock(f.policy, randomUUID())).toThrow("LOCK_OWNER_UNKNOWN_REQUIRES_EXPLICIT_RECOVERY");
    const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
    writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
    expect(() => recoverEvidenceLock(f.policy, randomUUID())).toThrow("LOCK_OWNER_MISMATCH");
  });
});
