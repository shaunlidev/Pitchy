/** Layout adapter for the approved start-over archive, not a product/test orchestrator. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export function archiveInventory(workspace: string) {
  const path = resolve(workspace, 'archive/migration-2026-10-11.json');
  if (!existsSync(path)) throw new Error('BLOCKED_CONTEXT: the historical archive inventory is unavailable.');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.schemaVersion !== 1 || record.status !== 'relocated_and_verified' || !Array.isArray(record.files)) throw new Error('BLOCKED_CONTEXT: incomplete archive inventory.');
  return record;
}

export function historicalPath(workspace: string, path: string) {
  const absolute = resolve(workspace, path);
  // The user's original Downloads mockup is external provenance, not a relocation target.
  if (!absolute.startsWith(workspace + sep)) return absolute;
  const original = relative(workspace, absolute);
  const file = archiveInventory(workspace).files.find((f: any) => f.from === original);
  if (!file) throw new Error(`Historical path has no relocation record: ${path}`);
  const current = resolve(workspace, file.to);
  if (!current.startsWith(resolve(workspace, 'archive/pre-v6') + sep)) throw new Error(`Historical path escaped the archive: ${path}`);
  return current;
}

export const diskBytes = (path: string) => Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split(/\s/)[0]) * 1024;

export function evidenceUsage(root: string, manifest: any) {
  const workspace = resolve(root, '..');
  archiveInventory(workspace); // Missing old evidence context must never count as zero.
  const roots = [...manifest.evidencePolicy.accountingPackageRoots.map((path: string) => ({ path: resolve(root, path), required: true })),
    ...manifest.evidencePolicy.accountingWorkspaceRoots.map((entry: { path: string; required: boolean }) => ({ ...entry, path: resolve(workspace, entry.path) }))];
  const paths = roots.map(entry => entry.path);
  if (paths.some((path, index) => paths.some((other, j) => j !== index && (path === other || path.startsWith(other + sep))))) throw new Error('Overlapping evidence roots would double-count usage.');
  return roots.map(entry => {
    if (!entry.path.startsWith(workspace + sep)) throw new Error('Evidence root escaped workspace.');
    if (!existsSync(entry.path) && entry.required) throw new Error(`BLOCKED_CONTEXT: required evidence root missing: ${entry.path}`);
    return { path: relative(workspace, entry.path), bytes: existsSync(entry.path) ? diskBytes(entry.path) : 0 };
  });
}
