import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { hashTaskBytes, hashTaskValue } from "./schema";

const text = z.string().min(1);
const localPath = text.refine(value => !isAbsolute(value) && !value.split(/[\\/]/).some(part => ["", ".", ".."].includes(part)), "Expected a bounded relative path.");
const referenceSchema = z.object({
  path: localPath, linkText: text, target: text.refine(isAbsolute),
  category: z.enum(["dependency_reference", "build_cache_reference"]), evidenceRef: text,
}).strict();
const policyInputSchema = z.object({
  repositoryRoot: text.refine(isAbsolute), recordDirectory: localPath,
  referenceLinks: z.array(referenceSchema), legacyWriters: z.enum(["quiescent", "not_verified"]),
}).strict();
const manifestSchema = z.object({ evidencePolicy: z.object({
  approvedCapBytes: z.number().int().positive().max(320_000_000),
  accountingPackageRoots: z.array(localPath).min(1),
  accountingWorkspaceRoots: z.array(z.object({ path: localPath, required: z.boolean() })).min(1),
}) });
const lockOwnerSchema = z.object({ pid: z.number().int().positive(), host: text, token: z.string().uuid() }).strict();
const CONTROL_RESERVE = 4096;
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

export class TaskEvidenceError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function failEvidence(code: string): never { throw new TaskEvidenceError(code); }
export function errorCode(error: unknown) { return z.object({ code: z.string() }).safeParse(error).data?.code; }
export function assertUnlinkedPath(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    // lstat also detects dangling links; existsSync alone would miss them.
    try { if (lstatSync(current).isSymbolicLink()) failEvidence("EVIDENCE_PATH_SYMLINK"); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    if (dirname(current) === current) break;
  }
}

export function loadEvidencePolicy(raw: unknown) {
  const input = policyInputSchema.parse(raw);
  const repositoryRoot = realpathSync(input.repositoryRoot);
  const recordRoot = resolve(repositoryRoot, input.recordDirectory);
  const appArtifacts = join(repositoryRoot, "pitchroom-app/.artifacts");
  if (!inside(recordRoot, appArtifacts) || recordRoot === appArtifacts) failEvidence("RECORD_ROOT_OUTSIDE_ACCOUNTED_ARTIFACTS");
  assertUnlinkedPath(recordRoot);
  const manifestPath = join(repositoryRoot, "pitchroom-v6/manifest.json");
  assertUnlinkedPath(manifestPath);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  const declared = [
    ...manifest.evidencePolicy.accountingPackageRoots.map(path => ({ path: join(repositoryRoot, "pitchroom-v6", path), required: true })),
    ...manifest.evidencePolicy.accountingWorkspaceRoots.map(item => ({ path: join(repositoryRoot, item.path), required: item.required })),
    { path: appArtifacts, required: true },
  ];
  for (const root of declared) {
    if (!existsSync(root.path) && root.required) failEvidence("MISSING_EVIDENCE_ROOT");
    if (existsSync(root.path)) assertUnlinkedPath(root.path);
  }
  const roots = [...new Set(declared.filter(item => existsSync(item.path)).map(item => realpathSync(item.path)))].sort();
  const uniqueRoots = roots.filter(path => !roots.some(other => path !== other && inside(path, other)));
  if (new Set(input.referenceLinks.map(item => item.path)).size !== input.referenceLinks.length) failEvidence("DUPLICATE_REFERENCE_RECEIPT");
  return {
    ...input, repositoryRoot, recordRoot, roots: uniqueRoots, declaredRoots: declared,
    manifestPath, manifestHash: hashTaskBytes(manifestBytes),
    capBytes: manifest.evidencePolicy.approvedCapBytes,
    policyHash: hashTaskValue({ repositoryRoot, recordRoot, manifestHash: hashTaskBytes(manifestBytes), references: input.referenceLinks }),
  };
}
export type EvidencePolicy = ReturnType<typeof loadEvidencePolicy>;

export function inspectEvidenceCapacity(policy: EvidencePolicy) {
  assertUnlinkedPath(policy.manifestPath);
  if (hashTaskBytes(readFileSync(policy.manifestPath)) !== policy.manifestHash) failEvidence("EVIDENCE_POLICY_CHANGED");
  const usedReferences = new Set<string>();
  const references = new Map(policy.referenceLinks.map(item => [resolve(policy.repositoryRoot, item.path), item]));
  for (const root of policy.declaredRoots) if (root.required && !existsSync(root.path)) failEvidence("MISSING_EVIDENCE_ROOT");
  const scan = (path: string): number => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      const receipt = references.get(path);
      if (!receipt || readlinkSync(path) !== receipt.linkText || realpathSync(path) !== receipt.target || !statSync(path).isDirectory()) failEvidence("UNCLASSIFIED_OR_CHANGED_EVIDENCE_LINK");
      const targetParts = relative(policy.repositoryRoot, receipt.target).split(sep);
      const workspaceDependency = targetParts[0] === "pitchroom-app" && ["packages", "apps"].includes(targetParts[1]) && targetParts[3] === "node_modules" && existsSync(join(policy.repositoryRoot, ...targetParts.slice(0, 3), "package.json"));
      const dependencyTarget = inside(receipt.target, join(policy.repositoryRoot, "pitchroom-app/node_modules")) || workspaceDependency || policy.roots.some(root => inside(receipt.target, root));
      if (receipt.category === "dependency_reference" && (!relative(policy.repositoryRoot, path).split(sep).includes("node_modules") || !dependencyTarget)) failEvidence("INVALID_DEPENDENCY_REFERENCE");
      if (receipt.category === "build_cache_reference" && (!path.split(sep).at(-1)?.startsWith(".next") || !inside(receipt.target, realpathSync(tmpdir())))) failEvidence("INVALID_BUILD_CACHE_REFERENCE");
      usedReferences.add(receipt.path);
      return st.size; // The reviewed target is a dependency/cache reference, not relocated raw QA.
    }
    if (st.isDirectory()) return readdirSync(path).sort().reduce((total, name) => total + scan(join(path, name)), 0);
    if (!st.isFile()) failEvidence("UNSUPPORTED_EVIDENCE_FILE_MODE");
    return st.size;
  };
  let usedBytes = 0;
  // Optional roots that appear later must also be included; do not trust a stale root snapshot.
  const current = [...new Set(policy.declaredRoots.filter(item => existsSync(item.path)).map(item => {
    assertUnlinkedPath(item.path); return realpathSync(item.path);
  }))];
  const roots = current.filter(path => !current.some(other => path !== other && inside(path, other)));
  for (const root of roots) usedBytes += scan(root);
  if (usedReferences.size !== policy.referenceLinks.length) failEvidence("STALE_REFERENCE_RECEIPT");
  return { capBytes: policy.capBytes, usedBytes, remainingBytes: policy.capBytes - usedBytes, roots, classifiedLinks: usedReferences.size, policyHash: policy.policyHash };
}

export function evidenceTreeBytes(root: string): number {
  const st = lstatSync(root);
  if (st.isSymbolicLink()) failEvidence("SESSION_SYMLINK");
  if ((st.mode & 0o077) !== 0) failEvidence("INSECURE_SESSION_MODE");
  if (st.isDirectory()) return readdirSync(root).reduce((sum, name) => sum + evidenceTreeBytes(join(root, name)), 0);
  if (!st.isFile()) failEvidence("UNSUPPORTED_EVIDENCE_FILE_MODE");
  return st.size;
}
export function ensurePrivateDirectory(path: string) {
  assertUnlinkedPath(path);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || (st.mode & 0o077) !== 0) failEvidence("INSECURE_EVIDENCE_DIRECTORY");
}
export function withEvidenceLock<T>(policy: EvidencePolicy, action: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T {
  if (policy.legacyWriters !== "quiescent") failEvidence("LEGACY_WRITERS_NOT_QUIESCENT");
  const before = inspectEvidenceCapacity(policy);
  if (before.remainingBytes < CONTROL_RESERVE) failEvidence("EVIDENCE_CAPACITY");
  ensurePrivateDirectory(policy.recordRoot);
  const lock = join(policy.recordRoot, ".write-lock"), recovery = join(policy.recordRoot, ".recovery-lock");
  if (existsSync(recovery)) failEvidence("RECOVERY_IN_PROGRESS");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (errorCode(error) === "EEXIST") failEvidence("EVIDENCE_LOCKED"); throw error; }
  const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  const ownerPath = join(lock, "owner.json");
  try {
    writeFileSync(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    if (existsSync(recovery)) failEvidence("RECOVERY_IN_PROGRESS");
    return action();
  } finally {
    if (existsSync(ownerPath)) {
      const actual = lockOwnerSchema.parse(JSON.parse(readFileSync(ownerPath, "utf8")));
      if (actual.token !== owner.token) failEvidence("LOCK_OWNER_CHANGED");
      unlinkSync(ownerPath);
    }
    rmdirSync(lock);
  }
}
export function reserveEvidenceWrite(policy: EvidencePolicy, input: { additionalBytes: number; sessionRoot: string; maximumSessionBytes: number }) {
  const { additionalBytes, maximumSessionBytes } = z.object({ additionalBytes: z.number().int().nonnegative(), maximumSessionBytes: z.number().int().positive() }).parse(input);
  const capacity = inspectEvidenceCapacity(policy);
  const stored = existsSync(input.sessionRoot) ? evidenceTreeBytes(input.sessionRoot) : 0;
  if (capacity.remainingBytes < additionalBytes || stored + additionalBytes > maximumSessionBytes) failEvidence("EVIDENCE_CAPACITY");
  return capacity;
}
export function recoverEvidenceLock(policy: EvidencePolicy, expectedToken: string) {
  const recovery = join(policy.recordRoot, ".recovery-lock"), lock = join(policy.recordRoot, ".write-lock");
  assertUnlinkedPath(policy.recordRoot);
  try { mkdirSync(recovery, { mode: 0o700 }); }
  catch (error) { if (errorCode(error) === "EEXIST") failEvidence("RECOVERY_IN_PROGRESS_REQUIRES_OWNER_REVIEW"); throw error; }
  try {
    assertUnlinkedPath(lock);
    const ownerPath = join(lock, "owner.json");
    if (!existsSync(ownerPath)) failEvidence("LOCK_OWNER_UNKNOWN_REQUIRES_EXPLICIT_RECOVERY");
    const owner = lockOwnerSchema.parse(JSON.parse(readFileSync(ownerPath, "utf8")));
    if (owner.token !== expectedToken || owner.host !== hostname()) failEvidence("LOCK_OWNER_MISMATCH");
    try { process.kill(owner.pid, 0); failEvidence("LOCK_OWNER_ALIVE"); }
    catch (error) { if (errorCode(error) !== "ESRCH") throw error; }
    unlinkSync(ownerPath); rmdirSync(lock);
    return { recoveredToken: owner.token, reason: "local_owner_process_no_longer_exists" as const };
  } finally { rmdirSync(recovery); }
}
