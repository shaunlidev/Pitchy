/** Read-only integrity check for one documentation package, not an application QA runner. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, relative, sep } from 'node:path';
import { diskBytes, evidenceUsage, historicalPath } from './workspace';

const root = resolve(import.meta.dir, '..');
const workspace = resolve(root, '..');
const checkWorkspace = process.argv.includes('--workspace');
const entry = 'manifest.json';
const m = JSON.parse(readFileSync(resolve(root, entry), 'utf8'));
const require = createRequire(import.meta.url);
const core = dirname(require.resolve('playwright-core/package.json'));
// Same installed readers used by the existing UI reporter; no added dependency.
const { PNG } = require(resolve(core, 'lib/utilsBundle.js'));
const { ZipFile } = require(resolve(core, 'lib/server/utils/zipFile.js'));
const failures: string[] = [];
const check = (ok: unknown, message: string) => { if (!ok) failures.push(message); };
const hash = (path: string) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const fingerprintMatches = (f: { path: string; sha256: string; bytes: number }) =>
  existsSync(resolve(root, f.path)) && statSync(resolve(root, f.path)).size === f.bytes && hash(f.path) === f.sha256;
const scopedScreenshot = (section: string, shot: { section: string }) => section === shot.section;
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const anchors = (text: string) => new Set([
  ...Array.from(text.matchAll(/<a id="([^"]+)"/g), x => x[1]),
  ...Array.from(text.matchAll(/^#{1,6}\s+(.+)$/gm), x => x[1].toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s/g, '-')),
]);
function validLink(from: string, target: string) {
  if (/^(https?:|mailto:)/.test(target)) return;
  const [file, fragment] = target.replace(/^<|>$/g, '').split('#');
  const path = file ? resolve(root, dirname(from), decodeURIComponent(file)) : resolve(root, from);
  check(path.startsWith(root + sep), `Link escapes the self-contained package: ${target}`);
  check(existsSync(path), `Missing link from ${from}: ${target}`);
  if (existsSync(path) && fragment) check(anchors(readFileSync(path, 'utf8')).has(fragment), `Missing anchor from ${from}: ${target}`);
}
const linkedPaths = (path: string) => Array.from(read(path).matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g), x => x[1]);
const docById = new Map(m.documents.map((d: any) => [d.id, d.path]));
const shots = new Map(m.screenshots.map((s: any) => [s.id, s]));
const checks = new Map(m.checks.map((c: any) => [c.id, c]));
const runs = new Map(m.runs.map((r: any) => [r.id, r]));
const requirements = new Map(m.requirements.map((r: any) => [r.id, r]));
const source = read(m.sourceArtifact.path);

check(m.schemaVersion === 2 && m.pathBase === 'package' && m.id === 'pitchroom-v6', 'Unsupported document schema/baseline');
check(m.documents.length === 5 && docById.size === 5, 'Expected five unique documents');
check(m.sections.map((s: any) => s.id).join(',') === 'MAT,CLR,POS,DCK', 'Four section IDs missing/out of order');
check(requirements.size === 16 && m.requirements.length === 16, 'Expected 16 unique requirement IDs');
check(shots.size === 9 && m.screenshots.length === 9, 'Expected nine unique screenshot IDs');
check(checks.size === 11 && m.checks.length === 11, 'Expected eleven unique check groups/assertions');
check(fingerprintMatches(m.sourceArtifact), 'Source HTML identity changed');
if (checkWorkspace) for (const f of m.runtimeAtDocumentation.dependencyFingerprints) check(fingerprintMatches({ ...f, path: historicalPath(workspace, f.path) }), `Historical dependency reference changed: ${f.path}`);
const relocation = JSON.parse(read(m.relocation.inventory));
for (const f of relocation.files.filter((f: any) => f.contentPolicy === 'immutable_bytes')) {
  check(fingerprintMatches({ path: f.to, sha256: f.sha256Before, bytes: f.bytesBefore }), `Relocation changed immutable content: ${f.from}`);
  if (checkWorkspace) check(!existsSync(resolve(workspace, f.from)), `Relocation left a duplicate at: ${f.from}`);
}

const reachable = new Set<string>(['README.md']);
let frontier = ['README.md'];
for (let depth = 0; depth < 2; depth++) {
  const next: string[] = [];
  for (const path of frontier) for (const link of linkedPaths(path)) {
    if (/^(https?:|mailto:)/.test(link)) continue;
    const target = relative(root, resolve(root, dirname(path), link.split('#')[0]));
    if (!target.endsWith('.md') || !existsSync(resolve(root, target)) || reachable.has(target)) continue;
    reachable.add(target); next.push(target);
  }
  frontier = next;
}
for (const d of m.documents) {
  check(existsSync(resolve(root, d.path)), `Missing document: ${d.path}`);
  check(reachable.has(d.path), `Not reachable within two clicks: ${d.path}`);
  if (existsSync(resolve(root, d.path))) for (const link of linkedPaths(d.path)) validLink(d.path, link);
}
for (const link of linkedPaths('evidence/README.md')) validLink('evidence/README.md', link);
if (checkWorkspace) check(readFileSync(resolve(workspace, 'README.md'), 'utf8').includes('pitchroom-v6/README.md'), 'Workspace entry missing package link');
for (const s of m.sections) {
  for (const key of ['prd', 'design', 'evidence']) validLink('README.md', s[key]);
  for (const id of [...s.requirementIds, ...s.crossRequirementIds]) check(requirements.has(id), `Unknown requirement: ${id}`);
  for (const id of s.requirementIds) check((requirements.get(id) as any)?.section === s.id, `Wrong requirement section: ${id}`);
  check(s.screenshotIds.includes(s.primaryScreenshotId), `Primary screenshot not listed: ${s.id}`);
  for (const id of s.screenshotIds) check(shots.has(id) && scopedScreenshot(s.id, shots.get(id) as any), `Wrong or missing section screenshot: ${id}`);
  for (const id of s.checkIds) check(checks.has(id), `Unknown check: ${id}`);
  for (const symbol of s.sourceSymbols) check(new RegExp(`(?:function|const)\\s+${symbol}\\b`).test(source), `Missing source symbol: ${symbol}`);
}
for (const r of m.requirements) {
  validLink('README.md', r.anchor);
  check(m.sections.some((s: any) => [...s.requirementIds, ...s.crossRequirementIds].includes(r.id)), `Unmapped requirement: ${r.id}`);
  check(read(docById.get('PRD') as string).includes(r.id), `Requirement missing from PRD: ${r.id}`);
}

const traceSummary: object[] = [];
for (const r of m.runs) {
  for (const kind of ['result', 'trace', 'script']) check(fingerprintMatches(r[kind]), `Missing/changed ${kind}: ${r.id}`);
  if (!existsSync(resolve(root, r.result.path))) continue;
  const result = JSON.parse(read(r.result.path));
  check(result.status === 'passed', `Recorded run not passed: ${r.id}`);
  check(Array.isArray(result.errors) && result.errors.length === 0, `Page errors or missing errors field: ${r.id}`);
  check(Array.isArray(result.external) && result.external.length === 0, `External requests or missing request field: ${r.id}`);
  check(result[r.sourceHashField] === m.sourceArtifact.sha256, `Run source mismatch: ${r.id}`);
  check(result[r.scriptHashField] === r.script.sha256, `Run script mismatch: ${r.id}`);
  for (const c of m.checks.filter((c: any) => c.runId === r.id)) {
    if (c.resultCheckIndex !== undefined) check(result.checks?.[c.resultCheckIndex] === c.description, `Recorded check mismatch: ${c.id}`);
    if (c.screenshotId) {
      const shot = shots.get(c.screenshotId) as any;
      check(result.screenshots?.some((s: any) => s.sha256 === shot?.sha256), `Capture result lacks image: ${c.id}`);
    }
  }
  if (checkWorkspace) for (const [path, sha] of Object.entries(result.originals || {})) {
    const absolute = historicalPath(workspace, path);
    check(existsSync(absolute) && hash(absolute) === sha, `Historical original changed/missing: ${path}`);
  }
  const zipPath = resolve(root, r.trace.path);
  try {
    const crc = spawnSync('unzip', ['-tqq', zipPath], { timeout: 15000, stdio: 'pipe' });
    if (crc.error || crc.status !== 0) throw new Error('ZIP CRC failed or unzip unavailable');
    const zip = new ZipFile(zipPath);
    let actions = 0, snapshots = 0;
    const types = new Set<string>();
    try {
      for (const name of (await zip.entries()).filter((n: string) => /\.(trace|network)$/.test(n))) {
        for (const line of (await zip.read(name)).toString('utf8').split('\n').filter(Boolean)) {
          const event = JSON.parse(line);
          if (typeof event.type !== 'string') throw new Error('Malformed trace event');
          types.add(event.type);
          if (event.type === 'before') actions++;
          if (event.type === 'frame-snapshot') snapshots++;
        }
      }
    } finally { zip.close(); }
    check(['context-options', 'before', 'after', 'frame-snapshot'].every(t => types.has(t)), `Trace missing context/actions/snapshots: ${r.id}`);
    check(actions === r.trace.actions && snapshots === r.trace.snapshots, `Trace event count drift: ${r.id}`);
    traceSummary.push({ run: r.id, actions, snapshots });
  } catch (error) { failures.push(`Unreadable trace ${r.id}: ${error}`); }
}
for (const c of m.checks) check(runs.has(c.runId), `Unowned check: ${c.id}`);
for (const s of m.screenshots) {
  check(fingerprintMatches(s), `Missing/changed screenshot: ${s.id}`);
  const run = runs.get(s.runId) as any;
  check(run && dirname(s.recordedPath) === dirname(run.result.recordedPath), `Screenshot belongs to another recorded run: ${s.id}`);
  check(relocation.files.some((f: any) => f.from === s.recordedPath && f.to === s.path && f.sha256Before === s.sha256), `Screenshot relocation missing: ${s.id}`);
  check(resolve(root, s.path).startsWith(resolve(root, 'screenshots') + sep), `Screenshot outside package screenshots folder: ${s.id}`);
  try {
    const png = PNG.sync.read(readFileSync(resolve(root, s.path)));
    check(png.width === s.pixels.width && png.height === s.pixels.height, `Image dimension mismatch: ${s.id}`);
  } catch (error) { failures.push(`Cannot decode ${s.id}: ${error}`); }
}

// Negative controls operate on copies/in memory. They never damage real evidence.
check(!fingerprintMatches({ ...m.sourceArtifact, sha256: '0'.repeat(64) }), 'Negative control accepted changed hash');
check(!fingerprintMatches({ ...m.sourceArtifact, path: m.sourceArtifact.path + '.__missing_document_test__' }), 'Negative control accepted missing artifact');
check(!scopedScreenshot('MAT', { section: 'DCK' }), 'Negative control accepted wrong section image');
const packageEvidenceBytes = m.evidencePolicy.accountingPackageRoots.reduce((n: number, p: string) => n + diskBytes(resolve(root, p)), 0);
const evidenceRoots = checkWorkspace ? evidenceUsage(root, m) : [];
const usedBytes = checkWorkspace ? evidenceRoots.reduce((n, entry) => n + entry.bytes, 0) : null;
check(m.evidencePolicy.approvedCapBytes === 320_000_000, 'Unapproved cap change');
const integrityStatus = failures.length ? 'FAIL' : 'PASS';
if (usedBytes !== null) check(usedBytes <= m.evidencePolicy.approvedCapBytes, 'Evidence exceeds approved capacity');
console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', integrityStatus, budgetStatus: usedBytes === null ? 'NOT_ASSESSED' : usedBytes > m.evidencePolicy.approvedCapBytes ? 'BLOCKED_BUDGET' : 'WITHIN_CAP', scope: 'Package documentation integrity only; no browser regression executed.', workspaceChecks: checkWorkspace ? 'checked' : 'not_requested', globalCapacity: checkWorkspace ? 'checked' : 'not_assessed_do_not_capture', documents: m.documents.length, sections: m.sections.length, requirements: m.requirements.length, screenshots: m.screenshots.length, traces: traceSummary, immutableRelocatedFiles: relocation.files.filter((f: any) => f.contentPolicy === 'immutable_bytes').length, negativeControls: 3, packageEvidenceBytes, evidenceRoots, usedBytes, capBytes: m.evidencePolicy.approvedCapBytes, failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
