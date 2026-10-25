/** Conservative evidence-budget maintenance for archived browser artifacts. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { evidenceUsage } from './workspace';

const root = resolve(import.meta.dir, '..');
const workspace = resolve(root, '..');
const archiveRoot = resolve(workspace, 'archive/pre-v6/artifacts');
const trashRoot = resolve(workspace, '.trash/evidence-auto-pruned');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const WARN_BYTES = 280_000_000;
const ACTION_BYTES = 300_000_000;
const TARGET_BYTES = 280_000_000;
const CAP_BYTES = manifest.evidencePolicy.approvedCapBytes;
const apply = process.argv.includes('--apply');

type FileRecord = { path: string; bytes: number; mtimeMs: number; hash?: string };
type Candidate = FileRecord & { kind: 'duplicate_report_trace' | 'archived_screenshot'; reason: string };

function walk(path: string): FileRecord[] {
  if (!existsSync(path)) return [];
  const found: FileRecord[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) found.push(...walk(child));
    else if (entry.isFile()) {
      const stat = statSync(child);
      found.push({ path: child, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return found;
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const isScreenshot = (path: string) => ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase());
const isReportDataZip = (path: string) => path.includes(`${sep}playwright-report${sep}data${sep}`) && extname(path) === '.zip';
const isOriginalTrace = (path: string) => basename(path) === 'trace.zip' && !path.includes(`${sep}playwright-report${sep}`);

export function selectCandidates(files: FileRecord[]): Candidate[] {
  const originalHashes = new Set(files.filter(file => isOriginalTrace(file.path)).map(file => sha256(file.path)));
  const duplicateReports = files.filter(file => isReportDataZip(file.path)).flatMap(file => {
    const hash = sha256(file.path);
    return originalHashes.has(hash) ? [{ ...file, hash, kind: 'duplicate_report_trace' as const, reason: 'Exact SHA-256 duplicate of an original trace.zip' }] : [];
  });
  const screenshots = files.filter(file => isScreenshot(file.path)).map(file => ({
    ...file,
    kind: 'archived_screenshot' as const,
    reason: 'Archived screenshot outside the current v6 manifest',
  }));
  const priority = { duplicate_report_trace: 0, archived_screenshot: 1 };
  return [...duplicateReports, ...screenshots].sort((a, b) =>
    priority[a.kind] - priority[b.kind] || a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
}

export function planPrune(usedBytes: number, candidates: Candidate[], targetBytes = TARGET_BYTES) {
  const selected: Candidate[] = [];
  let projectedBytes = usedBytes;
  for (const candidate of candidates) {
    if (projectedBytes <= targetBytes) break;
    selected.push(candidate);
    projectedBytes -= candidate.bytes;
  }
  return { selected, projectedBytes, reclaimedBytes: usedBytes - projectedBytes };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function moveCandidate(candidate: Candidate, batchRoot: string) {
  if (!candidate.path.startsWith(archiveRoot + sep)) throw new Error(`Candidate escaped archive: ${candidate.path}`);
  const destination = resolve(batchRoot, 'archive/pre-v6/artifacts', relative(archiveRoot, candidate.path));
  if (!destination.startsWith(batchRoot + sep) || existsSync(destination)) throw new Error(`Unsafe or occupied trash destination: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(candidate.path, destination);
  return destination;
}

function main() {
  const usage = evidenceUsage(root, manifest);
  const usedBytes = usage.reduce((sum, entry) => sum + entry.bytes, 0);
  const candidates = selectCandidates(walk(archiveRoot));
  const plan = usedBytes >= ACTION_BYTES ? planPrune(usedBytes, candidates) : { selected: [], projectedBytes: usedBytes, reclaimedBytes: 0 };
  const report: any = {
  status: usedBytes >= CAP_BYTES ? 'BLOCKED_CAP' : usedBytes >= ACTION_BYTES ? 'ACTION_THRESHOLD' : usedBytes >= WARN_BYTES ? 'WARNING_THRESHOLD' : 'OK',
  mode: apply ? 'apply' : 'preview',
  thresholds: { warningBytes: WARN_BYTES, actionBytes: ACTION_BYTES, targetBytes: TARGET_BYTES, capBytes: CAP_BYTES },
  usedBytes,
  availableBytes: CAP_BYTES - usedBytes,
  candidateCount: candidates.length,
  candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
  selectedCount: plan.selected.length,
  selectedBytes: plan.reclaimedBytes,
  projectedBytes: plan.projectedBytes,
  originalTracesSelected: 0,
  note: usedBytes < ACTION_BYTES
    ? 'Below automatic-maintenance threshold; no files selected.'
    : plan.projectedBytes > TARGET_BYTES
      ? 'Low-risk candidates are insufficient. Original traces remain untouched; request a capacity decision.'
      : 'Only exact report-trace duplicates and archived screenshots are selected. Current v6 evidence is out of scope.',
  files: plan.selected.map(candidate => ({ path: relative(workspace, candidate.path), bytes: candidate.bytes, kind: candidate.kind, reason: candidate.reason })),
  };

  if (apply && plan.selected.length) {
    const batchRoot = resolve(trashRoot, stamp());
    mkdirSync(batchRoot, { recursive: true });
    const moved = plan.selected.map(candidate => ({
      from: relative(workspace, candidate.path),
      to: relative(workspace, moveCandidate(candidate, batchRoot)),
      bytes: candidate.bytes,
      kind: candidate.kind,
      sha256: candidate.hash || sha256(resolve(batchRoot, 'archive/pre-v6/artifacts', relative(archiveRoot, candidate.path))),
    }));
    const afterBytes = evidenceUsage(root, manifest).reduce((sum, entry) => sum + entry.bytes, 0);
    Object.assign(report, { status: afterBytes <= TARGET_BYTES ? 'PRUNED' : 'PARTIAL_PRUNE', batch: relative(workspace, batchRoot), moved, actualBytes: afterBytes, availableBytes: CAP_BYTES - afterBytes });
    writeFileSync(resolve(batchRoot, 'manifest.json'), JSON.stringify(report, null, 2) + '\n');
  }

  console.log(JSON.stringify(report, null, 2));
  if (usedBytes >= CAP_BYTES && (!apply || plan.projectedBytes >= CAP_BYTES)) process.exitCode = 1;
}

if (import.meta.main) main();
